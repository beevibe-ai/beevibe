import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { Router, type RequestHandler } from "express";
import {
  daemonId as newDaemonId,
  runtimeId as newRuntimeId,
  sessionEventId as newSessionEventId,
  isTerminalSessionStatus,
  isKnownCli,
  type AgentRepository,
  type DaemonRepository,
  type PersonRepository,
  type Session,
  type SessionEventRepository,
  type SessionRepository,
  type RuntimeRepository,
} from "@beevibe/core";
import {
  generateDaemonApiKey,
  hashDaemonToken,
} from "@beevibe/core/auth";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import {
  composeIntent,
  composeSystemPromptAppend,
  teamAgentRoutingDirective,
} from "@beevibe/core/services/agent-session";
import { requireDaemon, requireHuman } from "../auth/middleware.js";
import type { DaemonHub } from "./hub.js";
import type {
  DispatchPayload,
  RuntimeDoneRequest,
  RuntimeEventInput,
  RuntimeEventsRequest,
  RuntimeHeartbeatRequest,
  RuntimeRegisterRequest,
  RuntimeRegisterResponse,
  RuntimeSkill,
  RuntimeSkillsResponse,
  RuntimeSyncRequest,
  RuntimeSyncResponse,
} from "./types.js";

export interface RuntimeRouterDeps {
  /** Required on every /runtime/* request. Resolves bv_u_ or bv_d_. */
  authMiddleware: RequestHandler;
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  daemonRepo: DaemonRepository;
  runtimeRepo: RuntimeRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  hub: DaemonHub;
  /** Per-agent factory for prepareBriefing at claim time. */
  makeMemoryAgent: (agentId: string) => MemoryAgent;
  /** Embedded into mcp-config.json by the daemon when spawning the CLI. */
  mcpServerUrl: string;
  /**
   * Path to the canonical skills directory (typically `<repo>/skills`).
   * Backs the GET /runtime/skills endpoint. The daemon mirrors this dir
   * to `~/.beevibe/skills/` and feeds its LocalWorkspaceManager so per-
   * agent tier-filtered sync produces identical workspaces server-side
   * and daemon-side.
   */
  skillsSourceDir: string;
  /** Hook fired after /runtime/done writes terminal state. Wired in M4.6. */
  onSessionComplete?: (session: Session) => void | Promise<void>;
}

/**
 * Mounts the /runtime/* surface used by beevibe-daemon instances.
 *
 *   POST /runtime/register    bv_u_ — upsert daemon + runtimes; mint bv_d_
 *   POST /runtime/heartbeat   bv_d_ — touch last_heartbeat per runtime
 *   POST /runtime/claim       bv_d_ — atomic claim of one pending session
 *   POST /runtime/events      bv_d_ — append session_event rows for a claimed session
 *   POST /runtime/done        bv_d_ — write terminal session state + fire resolver
 *
 * Authentication: the auth middleware accepts both bv_u_ and bv_d_; each
 * handler narrows further with `requireHuman` / `requireDaemon`.
 */
export function createRuntimeRouter(deps: RuntimeRouterDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.post("/register", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const body = parseRegisterBody(req.body);
    if (!body) {
      res.status(400).json({
        error: "invalid_body",
        message: "expected { external_id, device_name, runtimes: [{cli, cli_version?}] }",
      });
      return;
    }

    try {
      const { daemon, token, isNew } = await upsertDaemon(deps, req.caller!.personId, body);
      const runtimes = await upsertRuntimes(deps, daemon.id, body.runtimes);

      // Convenience auto-bind: only on the first-ever registration for
      // this daemon. After that, the caller's primary team agent is
      // either already bound (skip the lookup) or intentionally unbound
      // (don't re-bind on every heartbeat-style re-register).
      if (isNew && runtimes.length > 0) {
        await maybeAutoBindPrimaryAgent(deps, req.caller!.personId, runtimes[0]!.id);
      }

      const response: RuntimeRegisterResponse = {
        daemon_id: daemon.id,
        daemon_token: token,
        runtimes: runtimes.map((r) => ({ id: r.id, cli: r.cli })),
      };
      res.status(isNew ? 201 : 200).json(response);
    } catch (err) {
      console.error("[runtime/register]", err);
      res.status(500).json({ error: "register_failed" });
    }
  });

  // Re-runs CLI detection; upserts runtimes scoped by the bv_d_ — no
  // token rotation, unlike /register.
  router.post("/sync", async (req, res) => {
    if (!requireDaemon(req, res)) return;
    const body = parseSyncBody(req.body);
    if (!body) {
      res.status(400).json({
        error: "invalid_body",
        message: "expected { runtimes: [{cli, cli_version?}] }",
      });
      return;
    }
    try {
      const runtimes = await upsertRuntimes(deps, req.caller!.daemonId, body.runtimes);
      const response: RuntimeSyncResponse = {
        runtimes: runtimes.map((r) => ({ id: r.id, cli: r.cli })),
      };
      res.status(200).json(response);
    } catch (err) {
      console.error("[runtime/sync]", err);
      res.status(500).json({ error: "sync_failed" });
    }
  });

  router.post("/heartbeat", async (req, res) => {
    if (!requireDaemon(req, res)) return;
    const body = req.body as Partial<RuntimeHeartbeatRequest>;
    if (!Array.isArray(body.runtime_ids) || body.runtime_ids.length === 0) {
      res.status(400).json({ error: "invalid_body", message: "runtime_ids required" });
      return;
    }
    const runtimeIds = body.runtime_ids.filter(
      (id): id is string => typeof id === "string",
    );
    try {
      await deps.daemonRepo.touchLastSeen(req.caller!.daemonId);
      await Promise.all(runtimeIds.map((id) => deps.runtimeRepo.heartbeat(id)));
      // Mirror the DB heartbeat into the in-memory hub so `isOnline`
      // (used by chat 503 + the runtimes panel dot) keeps returning
      // true even if the WS push channel has dropped.
      for (const id of runtimeIds) deps.hub.bumpLastSeen(id);
      res.status(204).send();
    } catch (err) {
      console.error("[runtime/heartbeat]", err);
      res.status(500).json({ error: "heartbeat_failed" });
    }
  });

  router.post("/claim", async (req, res) => {
    if (!requireDaemon(req, res)) return;
    const runtimeIdParam = req.query.runtime_id;
    if (typeof runtimeIdParam !== "string" || !runtimeIdParam) {
      res.status(400).json({ error: "missing_runtime_id" });
      return;
    }

    try {
      const runtime = await deps.runtimeRepo.findById(runtimeIdParam);
      if (!runtime) {
        res.status(404).json({ error: "runtime_not_found" });
        return;
      }
      if (runtime.daemon_id !== req.caller!.daemonId) {
        res.status(403).json({ error: "runtime_not_owned" });
        return;
      }

      const claimed = await deps.sessionRepo.claimNextForRuntime(runtimeIdParam);
      if (!claimed) {
        res.status(204).send();
        return;
      }

      const payload = await composeDispatchPayload(deps, claimed);
      if (!payload) {
        // Agent vanished after claim — mark the session failed so it
        // doesn't sit running forever; rely on dispatch crash_recovery to
        // surface the issue if a retry is appropriate.
        await deps.sessionRepo.update(claimed.id, {
          status: "failed",
          error: "agent_missing_at_claim",
          completed_at: new Date(),
        });
        res.status(409).json({ error: "agent_missing" });
        return;
      }
      res.status(200).json(payload);
    } catch (err) {
      console.error("[runtime/claim]", err);
      res.status(500).json({ error: "claim_failed" });
    }
  });

  router.post("/events", async (req, res) => {
    if (!requireDaemon(req, res)) return;
    const body = req.body as Partial<RuntimeEventsRequest>;
    if (!Array.isArray(body.events) || body.events.length === 0) {
      res.status(400).json({ error: "invalid_body", message: "events required" });
      return;
    }
    const events = body.events.filter(isValidEvent);
    if (events.length === 0) {
      res.status(400).json({ error: "no_valid_events" });
      return;
    }

    try {
      const allowed = await assertDaemonOwnsSessions(
        deps,
        req.caller!.daemonId,
        new Set(events.map((e) => e.session_id)),
      );
      if (!allowed) {
        res.status(403).json({ error: "session_not_owned" });
        return;
      }
      await Promise.all(
        events.map((evt) =>
          deps.sessionEventRepo.append({
            id: newSessionEventId(),
            session_id: evt.session_id,
            kind: evt.kind,
            content: evt.content,
            tool_name: evt.tool_name,
          }),
        ),
      );
      res.status(204).send();
    } catch (err) {
      console.error("[runtime/events]", err);
      res.status(500).json({ error: "events_failed" });
    }
  });

  router.post("/done", async (req, res) => {
    if (!requireDaemon(req, res)) return;
    const body = req.body as Partial<RuntimeDoneRequest>;
    if (!body.session_id || typeof body.session_id !== "string") {
      res.status(400).json({ error: "invalid_body", message: "session_id required" });
      return;
    }
    if (!isTerminalSessionStatus(body.status)) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }

    try {
      const allowed = await assertDaemonOwnsSessions(
        deps,
        req.caller!.daemonId,
        new Set([body.session_id]),
      );
      if (!allowed) {
        res.status(403).json({ error: "session_not_owned" });
        return;
      }
      const updated = await deps.sessionRepo.update(body.session_id, {
        status: body.status,
        cli_session_id: body.cli_session_id,
        result_summary: body.result_summary,
        exit_code: body.exit_code,
        error: body.error,
        usage: body.usage,
        completed_at: new Date(),
      });
      if (deps.onSessionComplete) {
        // Fire-and-forget; resolver/post-dispatch errors must not fail the
        // daemon's request.
        Promise.resolve(deps.onSessionComplete(updated)).catch((err: unknown) =>
          console.warn(
            "[runtime/done] onSessionComplete failed:",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
      res.status(204).send();
    } catch (err) {
      console.error("[runtime/done]", err);
      res.status(500).json({ error: "done_failed" });
    }
  });

  router.get("/skills", async (req, res) => {
    if (!requireDaemon(req, res)) return;
    try {
      const response = await readSkills(deps.skillsSourceDir);
      res.status(200).json(response);
    } catch (err) {
      console.error("[runtime/skills]", err);
      res.status(500).json({ error: "skills_read_failed" });
    }
  });

  return router;
}

/* ─── helpers ────────────────────────────────────────────────────────── */

/**
 * Shape check for the `runtimes: [{cli, cli_version?}]` array shared by
 * /register and /sync. Returns the typed array or null on any
 * structural defect — caller decides whether the surrounding body is
 * still valid.
 */
function parseRuntimesArray(
  input: unknown,
): RuntimeRegisterRequest["runtimes"] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  for (const r of input) {
    if (!r || typeof r !== "object") return null;
    const e = r as Partial<{ cli: unknown; cli_version: unknown }>;
    if (typeof e.cli !== "string" || !e.cli) return null;
    if (e.cli_version !== undefined && typeof e.cli_version !== "string") return null;
  }
  return input as RuntimeRegisterRequest["runtimes"];
}

function parseRegisterBody(body: unknown): RuntimeRegisterRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<RuntimeRegisterRequest>;
  if (typeof b.external_id !== "string" || !b.external_id) return null;
  if (typeof b.device_name !== "string" || !b.device_name) return null;
  const runtimes = parseRuntimesArray(b.runtimes);
  if (!runtimes) return null;
  return { external_id: b.external_id, device_name: b.device_name, runtimes };
}

function parseSyncBody(body: unknown): RuntimeSyncRequest | null {
  if (!body || typeof body !== "object") return null;
  const runtimes = parseRuntimesArray((body as Partial<RuntimeSyncRequest>).runtimes);
  if (!runtimes) return null;
  return { runtimes };
}

function isValidEvent(e: unknown): e is RuntimeEventInput {
  if (!e || typeof e !== "object") return false;
  const r = e as Partial<RuntimeEventInput>;
  return (
    typeof r.session_id === "string" &&
    !!r.session_id &&
    (r.kind === "agent" ||
      r.kind === "tool_call" ||
      r.kind === "tool_result" ||
      r.kind === "summary") &&
    typeof r.content === "string" &&
    (r.tool_name === undefined || typeof r.tool_name === "string")
  );
}

/**
 * Best-effort auto-bind of the caller's primary team agent to a freshly
 * registered runtime. Called only on a daemon's first register
 * (`isNew`) so we don't pay the agent lookup on every re-register.
 *
 * Skips silently when the agent already has a binding so re-running
 * setup on a different machine doesn't yank the user out from under
 * the original daemon.
 */
async function maybeAutoBindPrimaryAgent(
  deps: RuntimeRouterDeps,
  ownerPersonId: string,
  runtimeId: string,
): Promise<void> {
  try {
    const primary = await deps.agentRepo.findTopLevelForOwner(ownerPersonId);
    if (!primary || primary.preferred_runtime_id) return;
    await deps.agentRepo.update(primary.id, { preferred_runtime_id: runtimeId });
    console.log(
      `[runtime/register] auto-bound agent ${primary.id} → runtime ${runtimeId}`,
    );
  } catch (err) {
    console.warn(
      "[runtime/register] auto-bind failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

async function upsertDaemon(
  deps: RuntimeRouterDeps,
  ownerPersonId: string,
  body: RuntimeRegisterRequest,
): Promise<{ daemon: { id: string; owner_person_id: string }; token: string; isNew: boolean }> {
  const token = generateDaemonApiKey();
  const tokenHash = hashDaemonToken(token);
  const existing = await deps.daemonRepo.findByOwnerAndExternalId(
    ownerPersonId,
    body.external_id,
  );
  if (existing) {
    const updated = await deps.daemonRepo.update(existing.id, {
      device_name: body.device_name,
      token_hash: tokenHash,
      revoked_at: undefined,
    });
    return { daemon: updated, token, isNew: false };
  }
  const created = await deps.daemonRepo.create({
    id: newDaemonId(),
    owner_person_id: ownerPersonId,
    external_id: body.external_id,
    device_name: body.device_name,
    token_hash: tokenHash,
  });
  return { daemon: created, token, isNew: true };
}

async function upsertRuntimes(
  deps: RuntimeRouterDeps,
  daemonId: string,
  inputs: RuntimeRegisterRequest["runtimes"],
): Promise<Array<{ id: string; cli: string }>> {
  return Promise.all(
    inputs.map(async (input) => {
      const existing = await deps.runtimeRepo.findByDaemonAndCli(daemonId, input.cli);
      if (existing) {
        const updated = input.cli_version
          ? await deps.runtimeRepo.update(existing.id, { cli_version: input.cli_version })
          : existing;
        return { id: updated.id, cli: updated.cli };
      }
      const created = await deps.runtimeRepo.create({
        id: newRuntimeId(),
        daemon_id: daemonId,
        cli: input.cli,
        cli_version: input.cli_version,
      });
      return { id: created.id, cli: created.cli };
    }),
  );
}

async function composeDispatchPayload(
  deps: RuntimeRouterDeps,
  session: Session,
): Promise<DispatchPayload | null> {
  const agent = await deps.agentRepo.findById(session.agent_id);
  if (!agent || !agent.api_key) return null;
  const claimedRuntime = session.runtime_id
    ? await deps.runtimeRepo.findById(session.runtime_id)
    : undefined;
  const runtimeType = isKnownCli(claimedRuntime?.cli)
    ? claimedRuntime.cli
    : agent.runtime_config.type;

  const memoryAgent = deps.makeMemoryAgent(agent.id);
  const isChat = session.type === "chat";
  const isTeamAgent = agent.hierarchy_level === "team";
  // Briefing, prior-session, (for chat) onboarding-state, and (for team
  // agents) subordinate roster lookups are independent — overlap them
  // so the resume-chain hot path doesn't pay all round-trips serially.
  const [briefing, priorSession, owner, subordinates] = await Promise.all([
    memoryAgent.prepareBriefing(session.intent),
    session.prior_session_id
      ? deps.sessionRepo.findById(session.prior_session_id)
      : Promise.resolve(undefined),
    isChat ? deps.personRepo.findById(agent.owner_id) : Promise.resolve(undefined),
    isTeamAgent
      ? deps.agentRepo.findSubordinates(agent.id)
      : Promise.resolve([]),
  ]);
  // Routing is suppressed during onboarding so the wizard directives
  // drive the build-your-team conversation themselves.
  const isOnboarding = isChat && !owner?.onboarding_completed_at;
  const teamRouting =
    isTeamAgent && !isOnboarding
      ? teamAgentRoutingDirective(subordinates.map((s) => s.name))
      : "";

  // Persist briefing snapshot for the session detail page. Awaited (was
  // fire-and-forget) so /runtime/claim can't return before the snapshot
  // lands — eliminates a race where the session detail page would read
  // the row before the persist completes, and the integration tests
  // would see briefing undefined.
  try {
    await deps.sessionRepo.update(session.id, { briefing: briefing.snapshot });
  } catch (err) {
    console.warn(
      "[runtime/claim] briefing snapshot persist failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    session_id: session.id,
    agent_id: agent.id,
    agent_api_key: agent.api_key,
    agent_hierarchy_level: agent.hierarchy_level,
    runtime_type: runtimeType,
    intent: composeIntent(session.intent, briefing.userMessagePrefix),
    system_prompt_append: composeSystemPromptAppend(
      agent.runtime_config.system_prompt_addition,
      briefing.systemPromptAppend,
      {
        sessionKind: isChat ? "chat" : "task",
        appendOnboardingDirectives: isOnboarding,
        extra: teamRouting,
      },
    ),
    resume_session_id: priorSession?.cli_session_id,
    model: agent.runtime_config.model,
    max_turns: agent.runtime_config.max_turns,
    env: { BEEVIBE_SESSION_ID: session.id, BEEVIBE_AGENT_ID: agent.id },
    type: session.type,
    mcp_server_url: deps.mcpServerUrl,
  };
}

/**
 * Read every skill directory under `sourceDir` and bundle each file's
 * content into a `RuntimeSkillsResponse`. Daemons receive ALL skills
 * (not tier-filtered) — the per-agent tier filter runs daemon-side
 * inside `LocalWorkspaceManager.ensureWorkspace` so a single bundle
 * serves agents at every tier on the same machine.
 *
 * `version` is a stable SHA-256 over (skill name, file path, content)
 * tuples in lexicographic order; daemons short-circuit re-download
 * when their cached version matches.
 */
async function readSkills(sourceDir: string): Promise<RuntimeSkillsResponse> {
  const skills: RuntimeSkill[] = [];
  let dirEntries: import("node:fs").Dirent[];
  try {
    dirEntries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    // Skills dir missing → return empty bundle. Daemons sync nothing
    // and the agent runs without skills (degrades gracefully).
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: "empty", skills: [] };
    }
    throw err;
  }
  for (const dirent of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;
    const skillDir = join(sourceDir, dirent.name);
    const files = await readSkillFiles(skillDir);
    if (files.length === 0) continue;
    skills.push({ name: dirent.name, files });
  }
  const hasher = createHash("sha256");
  for (const skill of skills) {
    for (const file of skill.files) {
      hasher.update(skill.name);
      hasher.update("\0");
      hasher.update(file.path);
      hasher.update("\0");
      hasher.update(file.content);
      hasher.update("\0");
    }
  }
  return { version: hasher.digest("hex"), skills };
}

async function readSkillFiles(
  skillDir: string,
): Promise<RuntimeSkillsResponse["skills"][number]["files"]> {
  const out: RuntimeSkillsResponse["skills"][number]["files"] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const content = await fs.readFile(abs, "utf8");
        out.push({ path: relative(skillDir, abs), content });
      }
    }
  }
  await walk(skillDir);
  return out;
}

/**
 * Single SQL JOIN: do all `sessionIds` belong to a runtime owned by
 * `daemonId`? True iff the JOIN yields exactly `sessionIds.size` rows.
 */
async function assertDaemonOwnsSessions(
  deps: RuntimeRouterDeps,
  daemonId: string,
  sessionIds: Set<string>,
): Promise<boolean> {
  if (sessionIds.size === 0) return true;
  const ids = [...sessionIds];
  const owned = await deps.sessionRepo.countOwnedByDaemon(daemonId, ids);
  return owned === ids.length;
}
