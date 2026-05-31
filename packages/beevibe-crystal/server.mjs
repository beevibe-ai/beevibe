// Stateless Anthropic proxy + capsule storage for Beevibe Crystal v0.
//
// Endpoints
//   POST /api/capsules           — body: raw .jsonl OR { capsule } JSON.
//                                  Returns { id, url, capsule }.
//   GET  /api/capsules/:id       — returns the stored capsule JSON.
//   POST /api/chat               — body: { capsule, history }. Visitor chat,
//                                  stance-inheritance mode.
//   GET  /api/health             — { ok, hasKey, storage }.
//
// Persistence: files under packages/beevibe-crystal/.capsules/<id>.json.
// No accounts, no auth, no expiration — v0 demo only.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { parseFile } from "./src/lib/parser.js";
import { ID_RE, isCapsule, textOfContent } from "./src/lib/schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.join(HERE, ".capsules");
const PORT = Number(process.env.PORT || 5274);
const VIEWER_URL = (process.env.CRYSTAL_VIEWER_URL || "http://localhost:5273").replace(/\/$/, "");
const MODEL = process.env.CRYSTAL_BALL_MODEL || "claude-sonnet-4-5";
const MAX_TOKENS = Number(process.env.CRYSTAL_BALL_MAX_TOKENS || 1024);
// Enrichment (lede + gist + starters + a multi-branch map) emits a chunk of
// JSON; 1800 truncated it on long sessions, leaving capsules with no map.
const GIST_MAX_TOKENS = Number(process.env.CRYSTAL_GIST_MAX_TOKENS || 4096);
const MAX_BODY = 25 * 1024 * 1024; // 25 MB — long Claude Code sessions get hefty

let anthropicClient;

function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  anthropicClient ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

await fs.mkdir(STORE_DIR, { recursive: true });

// -------- capsule storage --------------------------------------------------

// 48-bit hex id — large enough that random collision is negligible at v0
// scale, satisfies ID_RE (4..32 alphanumeric).
function newId() {
  return crypto.randomBytes(6).toString("hex");
}

async function saveCapsule(capsule) {
  // Defensive: the only path that calls this should have already set a
  // server-issued id. Reject otherwise so a malformed call can't traverse.
  if (!ID_RE.test(capsule.id || "")) {
    throw new Error("capsule.id missing or not server-issued");
  }
  const file = path.join(STORE_DIR, `${capsule.id}.json`);
  await fs.writeFile(file, JSON.stringify(capsule, null, 2), "utf8");
}

async function loadCapsule(id) {
  if (!ID_RE.test(id)) return null;
  try {
    const text = await fs.readFile(path.join(STORE_DIR, `${id}.json`), "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Capsule stays immutable; visitor Q&A goes in a sibling .visits.jsonl.
async function appendVisit(capsuleId, entry) {
  if (!ID_RE.test(capsuleId)) return;
  const file = path.join(STORE_DIR, `${capsuleId}.visits.jsonl`);
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

async function loadVisits(capsuleId) {
  if (!ID_RE.test(capsuleId)) return [];
  const file = path.join(STORE_DIR, `${capsuleId}.visits.jsonl`);
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// -------- handlers ---------------------------------------------------------

// Allowlist of content-types that carry a raw .jsonl session body.
const JSONL_CT = ["application/x-jsonl", "application/jsonl", "application/x-ndjson", "text/plain"];

async function handleCreateCapsule(req, res) {
  const ct = (req.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
  const raw = await readBody(req);

  let capsule;
  let warnings = [];
  try {
    if (ct === "application/json") {
      const body = JSON.parse(raw || "{}");
      if (body.capsule && isCapsule(body.capsule)) {
        capsule = body.capsule;
      } else if (typeof body.rawJsonl === "string") {
        ({ capsule, warnings } = parseFile(body.rawJsonl, body.filename || ""));
      } else if (typeof body.text === "string") {
        ({ capsule, warnings } = parseFile(body.text, body.filename || ""));
      } else {
        return reply(res, 400, "expected { capsule } or { rawJsonl } in JSON body");
      }
    } else if (JSONL_CT.includes(ct)) {
      ({ capsule, warnings } = parseFile(raw, ""));
    } else {
      return reply(
        res,
        415,
        `unsupported content-type: ${ct || "(none)"}. Use application/json with { capsule } / { rawJsonl }, or application/x-jsonl for raw session text.`
      );
    }
  } catch (err) {
    return reply(res, 400, `parse failed: ${err.message || err}`);
  }

  // Server owns id assignment — never trust client-supplied ids for the
  // filesystem path. Closes a path-traversal hole and avoids cross-publisher
  // id collisions from clients that share a tiny id space.
  capsule.id = newId();

  // Best-effort: ask the model for the publisher-voice gist + starter
  // questions. Failure is fine — capsule still publishes, mechanical summary
  // is the fallback, chips just don't appear.
  try {
    const { lede, gist, starters, map } = await generateGistAndStarters(capsule);
    if (lede) capsule.lede = lede;
    if (gist) capsule.gist = gist;
    if (starters?.length) capsule.starters = starters;
    if (map?.branches?.length) capsule.map = map;
  } catch (err) {
    console.warn("gist generation failed:", err.message || err);
  }

  await saveCapsule(capsule);
  const url = `${VIEWER_URL}/c/${capsule.id}`;
  return replyJson(res, 200, { id: capsule.id, url, capsule, warnings });
}

async function generateGistAndStarters(capsule) {
  const client = getAnthropicClient();
  if (!client) return {};
  const session = flattenCapsule(capsule);
  const result = await client.messages.create({
    model: MODEL,
    max_tokens: GIST_MAX_TOKENS,
    system: [
      `You are reading a Claude Code session that the publisher chose to share.`,
      `Produce a JSON object with four fields:`,
      ``,
      `1. "lede": ONE sentence in the publisher's voice (first person). The`,
      `   headline. What I did + the key outcome, max 18 words. Concrete.`,
      `   No hedging. No "I worked on" — say what you SHIPPED.`,
      ``,
      `2. "gist": STRICTLY 2 sentences (no more). Expand the lede with the one`,
      `   interesting decision or surprising tradeoff. Plain prose, no markdown.`,
      `   Hard limit: 45 words total. Cut anything that isn't load-bearing.`,
      ``,
      `3. "starters": exactly 3 short questions a visitor might click to start`,
      `   the conversation. Each ~5-12 words. SPECIFIC to this session — name`,
      `   real decisions, files, libraries, the actual problem. Not generic`,
      `   ("what did you learn?"). Lowercase, no trailing period.`,
      ``,
      `4. "map": a tree-structured outline of the session's work. The map is`,
      `   the PUBLIC SURFACE — visitors will see this instead of the raw`,
      `   transcript. Choose what to expose carefully; nothing sensitive.`,
      `   Schema:`,
      `   {`,
      `     "branches": [`,
      `       {`,
      `         "id": "slug-string",`,
      `         "title": "3-6 word noun phrase",`,
      `         "summary": "1-2 sentences in publisher voice (first person).",`,
      `         "children": [`,
      `           { "id": "slug-string", "title": "...", "summary": "..." }`,
      `         ]`,
      `       }`,
      `     ]`,
      `   }`,
      `   Aim for 3-5 top-level branches with 1-3 children each. IDs must be`,
      `   unique kebab-case slugs across the whole tree. Titles are short`,
      `   noun phrases (no verbs, no hedging). Summaries are first-person`,
      `   concrete — name real decisions, files, libraries when relevant.`,
      ``,
      `Output ONLY the JSON object. No preamble, no markdown fences, no commentary.`,
      ``,
      `--- SESSION ---`,
      session,
      `--- END SESSION ---`,
    ].join("\n"),
    messages: [{ role: "user", content: "Output the JSON now." }],
  });
  if (result.stop_reason === "max_tokens") {
    console.warn(
      `gist generation: response hit max_tokens (${GIST_MAX_TOKENS}) and was truncated — ` +
        `the JSON map is likely incomplete. Raise CRYSTAL_GIST_MAX_TOKENS if this recurs.`
    );
  }
  const text = (result.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const parsed = parseJsonLoose(text);
  // parseJsonLoose returns {} on any parse failure. That used to be silent, so
  // a truncated/garbled response looked identical to "no key" — capsules just
  // shipped with no lede or map and nothing in the logs. Make it observable.
  if (text && !parsed.lede && !parsed.map) {
    console.warn(
      `gist generation: model output did not parse into enrichment (lede/map empty). ` +
        `First 200 chars: ${text.slice(0, 200)}`
    );
  }
  return parsed;
}

// Models occasionally wrap JSON in ```json fences or prepend a sentence.
// Pull the largest balanced {...} we can find and parse that.
function parseJsonLoose(text) {
  if (!text) return {};
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
}

async function handleGetCapsule(res, id) {
  const capsule = await loadCapsule(id);
  if (!capsule) return reply(res, 404, "capsule not found");
  return replyJson(res, 200, capsule);
}

async function handleChat(req, res) {
  const body = JSON.parse((await readBody(req)) || "null");
  if (!body?.capsule || !Array.isArray(body?.history)) {
    return reply(res, 400, "bad request");
  }
  const client = getAnthropicClient();
  if (!client) {
    return reply(res, 500, "server is missing ANTHROPIC_API_KEY");
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });

  const messages = body.history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.text || "",
  }));

  // Load prior visits so the capsule remembers what's been asked, answered,
  // and replied to by the publisher. Empty on a fresh capsule.
  const priorVisits = await loadVisits(body.capsule.id);

  let full = "";
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystem(body.capsule, priorVisits),
      messages,
    });
    stream.on("text", (text) => {
      full += text;
      res.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
    });
    await stream.finalMessage();
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message || String(err) })}\n\n`);
    res.end();
    return;
  }

  const capsuleId = body.capsule.id;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : "anon";
  const visitorName = typeof body.visitorName === "string" ? body.visitorName.slice(0, 40) : "";
  const lastUser = body.history.findLast((m) => m.role !== "assistant");
  const ts = new Date().toISOString();
  // Chain the appends so user always lands before assistant in the log,
  // even under concurrent visitors.
  appendVisit(capsuleId, { ts, sessionId, visitorName, role: "user", text: lastUser?.text || "" })
    .then(() => appendVisit(capsuleId, { ts, sessionId, visitorName, role: "assistant", text: full }))
    .catch((e) => console.warn("visit log failed:", e.message));
}

async function handleGetVisits(res, id) {
  const visits = await loadVisits(id);
  return replyJson(res, 200, { visits });
}

async function handlePostReply(req, res, capsuleId) {
  const body = JSON.parse((await readBody(req)) || "null");
  const text = String(body?.text || "").trim();
  if (!text) return reply(res, 400, "text required");
  if (text.length > 4000) return reply(res, 400, "text too long");
  const replyToTs = typeof body?.replyToTs === "string" ? body.replyToTs : null;
  const replyToSession = typeof body?.replyToSession === "string" ? body.replyToSession.slice(0, 64) : null;
  const visitorName = typeof body?.visitorName === "string" ? body.visitorName.slice(0, 40) : "";
  const entry = {
    ts: new Date().toISOString(),
    sessionId: typeof body?.sessionId === "string" ? body.sessionId.slice(0, 64) : "anon",
    visitorName,
    role: "reply",
    text,
    replyTo: replyToTs && replyToSession ? { ts: replyToTs, sessionId: replyToSession } : undefined,
  };
  await appendVisit(capsuleId, entry);
  return replyJson(res, 200, { ok: true, entry });
}

// -------- system prompt (stance inheritance) -------------------------------

function flattenCapsule(capsule) {
  const lines = [];
  for (const e of capsule.events || []) {
    if (e.type === "message") {
      const text = textOfContent(e.content);
      if (!text) continue;
      lines.push(`[${e.role}] ${text}`);
    } else if (e.type === "tool_use") {
      lines.push(
        `[tool:${e.name}${e.ok === false ? " FAILED" : ""}] ${
          e.input ? JSON.stringify(e.input).slice(0, 400) : ""
        }`
      );
      if (e.result) lines.push(`[result] ${String(e.result).slice(0, 400)}`);
    } else if (e.type === "file_change") {
      lines.push(`[edit] ${e.path}\n${(e.diff || "").slice(0, 600)}`);
    } else if (e.type === "thinking") {
      const thought = String(e.content || "");
      if (thought) lines.push(`[thinking] ${thought.slice(0, 400)}`);
    }
  }
  const joined = lines.join("\n");
  return joined.length > 60000 ? "…[earlier omitted]\n" + joined.slice(-60000) : joined;
}

function buildSystem(capsule, priorVisits = []) {
  const session = flattenCapsule(capsule);
  const exchanges = formatVisitContext(priorVisits);
  return [
    `You are the voice of a Beevibe Crystal capsule - a frozen snapshot of an AI`,
    `collaboration session that the publisher chose to share. Visitors ask`,
    `questions and you answer as a continuation of the publisher's reasoning,`,
    `not as a neutral narrator.`,
    ``,
    `Rules:`,
    `1. Speak from the publisher's stance and conclusions. Use "I" / "we" as`,
    `   the publisher would. Don't say "the publisher decided X" — say "I went`,
    `   with X because…".`,
    `2. Ground every answer in the session below. If the answer isn't in the`,
    `   session, say so plainly — don't invent.`,
    `3. Be concise. Prefer the form: claim, then the specific moment in the`,
    `   session that supports it.`,
    `4. You may extrapolate one step beyond the session if asked ("what would`,
    `   you do next?"), but mark it as your extrapolation.`,
    `5. If a "publisher reply" appears below a prior exchange, treat it as the`,
    `   publisher correcting or extending the earlier answer. Defer to it.`,
    ``,
    `Capsule title: ${capsule.title || "(untitled)"}`,
    `Outcome: ${capsule.metadata?.outcome || "unknown"}`,
    `Topics: ${(capsule.metadata?.topics || []).join(", ") || "—"}`,
    ``,
    `--- SESSION ---`,
    session,
    `--- END SESSION ---`,
    exchanges ? `\n--- PRIOR VISITOR EXCHANGES ---\n${exchanges}\n--- END EXCHANGES ---` : "",
  ].join("\n");
}

// Pack the most recent visits into a context block: chronological, paired
// by sessionId where possible, with publisher replies attached. Bounded.
function formatVisitContext(visits) {
  if (!visits.length) return "";
  const KEEP = 20;
  const recent = visits.slice(-KEEP);
  const lines = [];
  for (const v of recent) {
    const who = v.visitorName ? ` (${v.visitorName})` : "";
    if (v.role === "user") lines.push(`[Q${who}] ${truncate(v.text, 400)}`);
    else if (v.role === "assistant") lines.push(`[A] ${truncate(v.text, 600)}`);
    else if (v.role === "reply") lines.push(`[publisher reply${who}] ${truncate(v.text, 600)}`);
  }
  const joined = lines.join("\n");
  return joined.length > 6000 ? "…[earlier exchanges omitted]\n" + joined.slice(-6000) : joined;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// -------- helpers ----------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function reply(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}
function replyJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// -------- router -----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      return replyJson(res, 200, {
        ok: true,
        hasKey: !!process.env.ANTHROPIC_API_KEY,
        storage: STORE_DIR,
        viewerUrl: VIEWER_URL,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/capsules") {
      return await handleCreateCapsule(req, res);
    }
    const get = url.pathname.match(/^\/api\/capsules\/([a-z0-9]{4,32})$/i);
    if (req.method === "GET" && get) {
      return await handleGetCapsule(res, get[1]);
    }
    const visitsGet = url.pathname.match(/^\/api\/capsules\/([a-z0-9]{4,32})\/visits$/i);
    if (req.method === "GET" && visitsGet) {
      return await handleGetVisits(res, visitsGet[1]);
    }
    const replyPost = url.pathname.match(/^\/api\/capsules\/([a-z0-9]{4,32})\/reply$/i);
    if (req.method === "POST" && replyPost) {
      return await handlePostReply(req, res, replyPost[1]);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      return await handleChat(req, res);
    }
    return reply(res, 404, "not found");
  } catch (err) {
    return reply(res, 500, `server error: ${err.message || err}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`beevibe-crystal server on http://127.0.0.1:${PORT}`);
  console.log(`  storage:  ${STORE_DIR}`);
  console.log(`  viewer:   ${VIEWER_URL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARN: ANTHROPIC_API_KEY not set — /api/chat returns 500.");
  }
});
