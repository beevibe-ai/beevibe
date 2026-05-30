import { emptyCapsule, isCapsule, textOfContent } from "./schema.js";

// Accept either:
//   1) A Claude Code session .jsonl (one JSON event per line)
//   2) A pre-baked capsule.json matching our schema
//
// Returns: { capsule, warnings: string[] }
export function parseFile(text, filename = "") {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("File is empty.");

  // Try whole-file JSON first (capsule.json case)
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isCapsule(parsed)) return { capsule: parsed, warnings: [] };
    } catch {
      // fall through to JSONL
    }
  }

  return parseClaudeCodeJsonl(trimmed, filename);
}

function parseClaudeCodeJsonl(text, filename) {
  const warnings = [];
  const lines = text.split("\n");
  const rawEvents = [];
  // Iterate with the original line number so warnings point at the source file,
  // not at the post-filter index.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rawEvents.push(JSON.parse(line));
    } catch {
      warnings.push(`Line ${i + 1}: not valid JSON, skipped.`);
    }
  }
  if (!rawEvents.length) throw new Error("No valid JSON lines found.");

  const capsule = emptyCapsule();
  capsule.id = makeId();
  capsule.source = "claude-code";
  capsule.title = guessTitle(rawEvents, filename);

  const events = [];
  const filesTouched = new Set();
  let firstTs = null;
  let lastTs = null;
  let model = "";

  for (const raw of rawEvents) {
    const ts = raw.timestamp || raw.ts || null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    // Claude Code variants: top-level `type`, or `message.role` shape
    const type = raw.type || (raw.message ? "message" : null);

    if (type === "message" || raw.message) {
      const msg = raw.message || raw;
      const role = msg.role || raw.role || "user";
      const content = normalizeContent(msg.content);
      if (msg.model && !model) model = msg.model;
      events.push({ type: "message", ts, role, content });

      // Tool uses are often inline in assistant content blocks
      if (role === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            events.push({
              type: "tool_use",
              ts,
              name: block.name || "unknown",
              input: block.input || {},
              result: null,
              ok: null,
              _toolUseId: block.id,
            });
          }
        }
      }
    } else if (type === "tool_result" || raw.toolUseResult) {
      const result = raw.toolUseResult || raw.content || raw.result;
      const useId = raw.tool_use_id || raw.toolUseId;
      // Attach to the FIRST unresolved tool_use (FIFO). Real Claude Code emits
      // tool_results in the same order as their tool_uses, so picking the
      // oldest pending call is correct. Require id match when one was provided.
      let match = null;
      for (const e of events) {
        if (e.type !== "tool_use" || e.result !== null) continue;
        if (useId && e._toolUseId !== useId) continue;
        match = e;
        break;
      }
      if (match) {
        match.result = summarizeToolResult(result);
        match.ok = !raw.is_error && !raw.error;
      } else {
        events.push({
          type: "tool_use",
          ts,
          name: "unknown",
          input: {},
          result: summarizeToolResult(result),
          ok: !raw.is_error && !raw.error,
        });
      }
    } else if (type === "file_change" || raw.path) {
      events.push({
        type: "file_change",
        ts,
        path: raw.path,
        before: raw.before || "",
        after: raw.after || "",
        diff: raw.diff || "",
      });
      if (raw.path) filesTouched.add(raw.path);
    } else if (type === "thinking") {
      events.push({ type: "thinking", ts, content: raw.content || "" });
    } else {
      warnings.push(`Unknown event type '${type ?? "<missing>"}' — skipped.`);
    }
  }

  // Single pass for metadata counts + file harvest. Replaces 4 filter() scans
  // and a second loop over events.
  let messageCount = 0;
  let toolCallCount = 0;
  let fileChangeCount = 0;
  let abandonedCount = 0;
  for (const e of events) {
    if (e.type === "message") {
      messageCount++;
    } else if (e.type === "tool_use") {
      toolCallCount++;
      if (e.ok === false) abandonedCount++;
      if (/Edit|Write/i.test(e.name)) fileChangeCount++;
      if (e.input?.file_path) filesTouched.add(e.input.file_path);
    } else if (e.type === "file_change") {
      fileChangeCount++;
    }
  }

  capsule.events = events;
  capsule.metadata.model = model;
  capsule.metadata.messageCount = messageCount;
  capsule.metadata.toolCallCount = toolCallCount;
  capsule.metadata.fileChangeCount = fileChangeCount;
  capsule.metadata.abandonedCount = abandonedCount;
  capsule.metadata.durationMs =
    firstTs && lastTs ? new Date(lastTs) - new Date(firstTs) : 0;
  capsule.metadata.outcome = guessOutcome(events);
  capsule.metadata.topics = guessTopics(events);
  capsule.context.files = [...filesTouched];
  capsule.summary = autoSummary(capsule);

  return { capsule, warnings };
}

function normalizeContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function summarizeToolResult(result) {
  if (result == null) return null;
  if (typeof result === "string") return truncate(result, 4000);
  if (typeof result === "object") {
    if (typeof result.stdout === "string") return truncate(result.stdout, 4000);
    if (typeof result.content === "string") return truncate(result.content, 4000);
    return truncate(JSON.stringify(result), 4000);
  }
  return String(result);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + `\n…[+${s.length - n} chars]` : s;
}

function guessTitle(rawEvents, filename) {
  for (const r of rawEvents) {
    const msg = r.message || (r.type === "message" ? r : null);
    if (msg?.role === "user") {
      const text = textOfContent(msg.content);
      const firstLine = text.split("\n").find((l) => l.trim());
      if (firstLine) return firstLine.slice(0, 80);
    }
  }
  return filename.replace(/\.[^/.]+$/, "") || "Untitled capsule";
}

function guessOutcome(events) {
  const last = events[events.length - 1];
  if (!last) return "in-progress";
  if (last.type === "message" && last.role === "assistant") {
    const text = textOfContent(last.content);
    if (/\b(done|fixed|resolved|works|shipped|merged)\b/i.test(text)) return "resolved";
    if (/\b(stuck|gave up|abandon|blocked)\b/i.test(text)) return "abandoned";
  }
  return "in-progress";
}

function guessTopics(events) {
  const text = events
    .filter((e) => e.type === "message")
    .map((e) => textOfContent(e.content))
    .join(" ")
    .toLowerCase();
  const topics = [];
  const tags = [
    ["debug", /\b(bug|debug|stack ?trace|crash|error)\b/],
    ["refactor", /\brefactor\b/],
    ["design", /\b(architecture|design|api|schema)\b/],
    ["infra", /\b(infra|deploy|docker|kubernetes|k8s|terraform)\b/],
    ["test", /\b(test|jest|vitest|pytest)\b/],
    ["data", /\b(sql|query|database|schema|migration)\b/],
    ["ui", /\b(ui|css|tailwind|component)\b/],
  ];
  for (const [name, re] of tags) if (re.test(text)) topics.push(name);
  return topics.slice(0, 3);
}

function autoSummary(capsule) {
  const { messageCount, toolCallCount, fileChangeCount, outcome, topics } =
    capsule.metadata;
  const topicPart = topics.length ? `, focused on ${topics.join(" + ")}` : "";
  return `${messageCount} messages, ${toolCallCount} tool calls, ${fileChangeCount} file edits${topicPart}. Outcome: ${outcome}.`;
}

// Client-side seed id. Server always overwrites this on persist — never trust
// it for filesystem paths.
function makeId() {
  return Math.random().toString(36).slice(2, 10);
}
