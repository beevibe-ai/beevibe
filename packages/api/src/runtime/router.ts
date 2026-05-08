import { Router, type Request, type RequestHandler, type Response } from "express";
import {
  daemonId as newDaemonId,
  runtimeId as newRuntimeId,
  sessionEventId as newSessionEventId,
  isTerminalSessionStatus,
  type AgentRepository,
  type Session,
  type SessionEventRepository,
  type SessionRepository,
} from "@beevibe/core";
import {
  generateDaemonApiKey,
  hashDaemonToken,
} from "@beevibe/core/auth";
import type {
  DaemonRepository,
  RuntimeRepository,
} from "@beevibe/core";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import {
  composeIntent,
  composeSystemPromptAppend,
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
} from "./types.js";

export interface RuntimeRouterDeps {
  /** Required on every /runtime/* request. Resolves bv_u_ or bv_d_. */
  authMiddleware: RequestHandler;
  agentRepo: AgentRepository;
  daemonRepo: DaemonRepository;
  runtimeRepo: RuntimeRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  hub: DaemonHub;
  /** Per-agent factory for prepareBriefing at claim time. */
  makeMemoryAgent: (agentId: string) => MemoryAgent;
  /** Embedded into mcp-config.json by the daemon when spawning the CLI. */
  mcpServerUrl: string;
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

  router.post("/heartbeat", async (req, res) => {
    if (!requireDaemon(req, res)) return;
    const body = req.body as Partial<RuntimeHeartbeatRequest>;
    if (!Array.isArray(body.runtime_ids) || body.runtime_ids.length === 0) {
      res.status(400).json({ error: "invalid_body", message: "runtime_ids required" });
      return;
    }
    try {
      await deps.daemonRepo.touchLastSeen(req.caller!.daemonId);
      await Promise.all(
        body.runtime_ids
          .filter((id): id is string => typeof id === "string")
          .map((id) => deps.runtimeRepo.heartbeat(id)),
      );
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

  return router;
}

/* ─── helpers ────────────────────────────────────────────────────────── */

function parseRegisterBody(body: unknown): RuntimeRegisterRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<RuntimeRegisterRequest>;
  if (typeof b.external_id !== "string" || !b.external_id) return null;
  if (typeof b.device_name !== "string" || !b.device_name) return null;
  if (!Array.isArray(b.runtimes) || b.runtimes.length === 0) return null;
  for (const r of b.runtimes) {
    if (!r || typeof r !== "object") return null;
    if (typeof r.cli !== "string" || !r.cli) return null;
    if (r.cli_version !== undefined && typeof r.cli_version !== "string") return null;
  }
  return b as RuntimeRegisterRequest;
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

  const memoryAgent = deps.makeMemoryAgent(agent.id);
  // Briefing + prior-session lookup are independent — overlap them so the
  // resume-chain hot path doesn't pay both round-trips serially.
  const [briefing, priorSession] = await Promise.all([
    memoryAgent.prepareBriefing(session.intent),
    session.prior_session_id
      ? deps.sessionRepo.findById(session.prior_session_id)
      : Promise.resolve(undefined),
  ]);

  // Persist briefing snapshot for the session detail page; best-effort.
  void deps.sessionRepo
    .update(session.id, { briefing: briefing.snapshot })
    .catch((err: unknown) =>
      console.warn(
        "[runtime/claim] briefing snapshot persist failed:",
        err instanceof Error ? err.message : String(err),
      ),
    );

  return {
    session_id: session.id,
    agent_id: agent.id,
    agent_api_key: agent.api_key,
    workspace_subdir: agent.id,
    intent: composeIntent(session.intent, briefing.userMessagePrefix),
    system_prompt_append: composeSystemPromptAppend(
      agent.runtime_config.system_prompt_addition,
      briefing.systemPromptAppend,
      { appendChatDirectives: session.type === "chat" },
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

