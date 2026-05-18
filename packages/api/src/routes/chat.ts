/**
 * Human chat surface — Phase 4 daemon-first.
 *
 * `POST /chat`: resolves the caller's primary (team/org) agent and
 * dispatches one chat turn via `dispatchService`. The pending session
 * is claimed by the agent's daemon (or, for null-runtime agents, the
 * legacy executor) which spawns the CLI and posts terminal state to
 * /runtime/done. /runtime/done fires `chatResolver`, which unblocks the
 * awaiting POST. Multi-turn continuity via `prior_session_id` (sent as
 * a `chat_continuation` ResumeReason so dispatchService pins runtime
 * and the spawn passes `--resume <prior.cli_session_id>`).
 *
 * Daemon offline: the dispatchService still inserts the pending session,
 * but no daemon is online to claim it. The chat handler awaits the
 * resolver until `CHAT_TURN_TIMEOUT_MS`, then 504. For agents without a
 * runtime binding the in-process executor claims it within ≤30s.
 *
 * `GET /chat`: returns the last N chat sessions for the caller's primary
 * agent, reconstructed as `{role, content, session_id, view_refs?,
 * open_view?}` messages so the chat surface can rehydrate after a
 * reload.
 */

import { randomUUID } from "node:crypto";
import { Router, type RequestHandler, type Response } from "express";
import {
  isInFlightSessionStatus,
  isKnownCli,
  type AgentRepository,
  type KnownCli,
  type PersonRepository,
  type RuntimeRepository,
  type SessionRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ResumeReason } from "@beevibe/core/services/agent-session";
import { isBareCliExitMessage } from "@beevibe/core/adapters/claude-code";
import { parseRuntimeMissingError } from "@beevibe/core/adapters/runtime-registry";
import { requireHuman } from "../auth/middleware.js";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { processResponse, type SuggestedAction } from "./directives.js";

export interface ChatRoutesDeps {
  authMiddleware: RequestHandler;
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  /** Needed by GET /chat to flag conversations pinned to an old CLI. */
  runtimeRepo: RuntimeRepository;
  sessionRepo: SessionRepository;
  /**
   * Phase 4 daemon-first chat path: dispatchService inserts a pending
   * session, the daemon (or executor for null-runtime agents) claims +
   * spawns, and /runtime/done fires the resolver below.
   */
  dispatchService: DispatchService;
  chatResolver: ChatResolver;
  /** Best-effort wakeup for the agent's daemon when one is online. */
  hub: DaemonHub;
  /** Optional override; tests inject one with a deterministic clock. */
  rateLimiter?: ChatRateLimiter;
}

// CHAT_DIRECTIVES has moved into @beevibe/core's spawn-prep so /runtime/claim
// can stamp it onto every chat session's system_prompt_append uniformly. The
// onboarding-directive variant from the feature branch is deferred to the
// #63 signup PR (it depends on person.onboarding_completed_at, which doesn't
// land until that work).

interface HistoryMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  session_id?: string;
  view_refs?: string[];
  open_view?: { path: string; label?: string };
  suggested_actions?: SuggestedAction[];
}

// Generic 500 — internal error text stays in server logs, indexed by
// request_id the client can paste into a bug report.
function handleError(err: unknown, res: Response): void {
  const requestId = `req_${randomUUID()}`;
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[chat route] ${requestId}`, detail);
  res.status(500).json({
    error: "internal_error",
    message: "Something went wrong. Try again in a moment.",
    request_id: requestId,
  });
}

const HISTORY_LIMIT = 50;
const CONVERSATIONS_LIMIT = 50;
const CONVERSATION_PREVIEW_CHARS = 140;
// Hard ceiling pulled from the DB so a heavy user with thousands of
// chat turns doesn't drag the route every page load. Generous (4×
// CONVERSATIONS_LIMIT × 2 turns/conversation gives plenty of headroom)
// while still bounded. Pagination is a follow-up.
const CHAT_FETCH_LIMIT = 400;

export interface ChatSession {
  id: string;
  prior_session_id?: string;
  intent: string;
  result_summary?: string;
  status: string;
  error?: string;
  created_at: Date;
  runtime_id?: string;
}

export interface ConversationChain {
  /** Head session id — first turn in the chain (no prior_session_id). */
  head_id: string;
  /** Sessions in chronological order (oldest first). */
  sessions: ChatSession[];
}

/**
 * Group chat sessions into conversation chains by walking
 * `prior_session_id` pointers. Each session ends up in exactly one
 * chain whose head is the first ancestor with no prior_session_id.
 *
 * Sessions whose prior_session_id points outside the input set (e.g.
 * the chain extends past the recent-N window) start a new chain at
 * themselves — preferable to dropping data, even if technically a
 * fragment of an older conversation.
 */
export function groupIntoConversations(
  sessions: readonly ChatSession[],
): ConversationChain[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const headOf = new Map<string, string>();
  // Iterative walk with a visited set so a cycle in `prior_session_id`
  // (which can only happen via data corruption — bad migration, manual
  // SQL fix) doesn't blow the stack. When we detect a cycle, treat the
  // first session in the cycle as the head; the chain still surfaces,
  // just at an arbitrary anchor point. Crashing here would take down
  // the entire chat history endpoint.
  const findHead = (start: ChatSession): string => {
    const cached = headOf.get(start.id);
    if (cached) return cached;
    const visited = new Set<string>();
    let cur: ChatSession = start;
    while (cur.prior_session_id) {
      if (visited.has(cur.id)) {
        // Cycle: bail with `cur` as the head. Cache for every node we
        // walked through so we don't re-walk on the next call.
        for (const id of visited) headOf.set(id, cur.id);
        return cur.id;
      }
      visited.add(cur.id);
      const parent = byId.get(cur.prior_session_id);
      if (!parent) break; // pointer outside input window — `cur` is head
      // Short-circuit: if we've already resolved an ancestor's head,
      // reuse it.
      const ancestorHead = headOf.get(parent.id);
      if (ancestorHead) {
        for (const id of visited) headOf.set(id, ancestorHead);
        headOf.set(start.id, ancestorHead);
        return ancestorHead;
      }
      cur = parent;
    }
    const head = cur.id;
    for (const id of visited) headOf.set(id, head);
    headOf.set(start.id, head);
    return head;
  };

  const chainsById = new Map<string, ChatSession[]>();
  for (const s of sessions) {
    const head = findHead(s);
    const arr = chainsById.get(head) ?? [];
    arr.push(s);
    chainsById.set(head, arr);
  }

  const chains: ConversationChain[] = [];
  for (const [head_id, chainSessions] of chainsById) {
    chainSessions.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    chains.push({ head_id, sessions: chainSessions });
  }
  // Newest conversation first (by latest activity in the chain).
  chains.sort(
    (a, b) =>
      b.sessions[b.sessions.length - 1]!.created_at.getTime() -
      a.sessions[a.sessions.length - 1]!.created_at.getTime(),
  );
  return chains;
}

/**
 * The bare "CLI exited with code N" message from parseClaudeMessages tells
 * the user nothing actionable — the daemon now also surfaces the CLI's
 * stderr tail (`session.error`), so prefer that when it's something other
 * than the same bare line. If neither holds anything useful, fall back to
 * a daemon-pointer message instead of "(turn failed — no response)".
 *
 * Exported so non-chat surfaces that render failed sessions (e.g. rooms)
 * can apply the same mapping rather than each site re-implementing it.
 */
const DAEMON_LOG_POINTER =
  "Couldn't reach your team agent. Check the terminal where you ran " +
  "`beevibe-daemon start` for the failure detail.";

/**
 * Rewrites the daemon's runtime-missing throw (e.g. user uninstalled
 * claude but the conversation is still pinned to a claude runtime row)
 * into a user-actionable message. The raw string is persisted as
 * `session.error` by /runtime/done; we recognize it via the shared
 * `parseRuntimeMissingError` matcher so the producer (`spawner.ts`'s
 * `runtimeMissingError(cli)`) and this consumer stay in sync.
 */
function rewriteRuntimeMissingError(raw: string): string | undefined {
  const cli = parseRuntimeMissingError(raw);
  if (!cli) return undefined;
  return (
    `This conversation is pinned to the ${cli} runtime, which isn't installed ` +
    `on the daemon claiming it. Install ${cli} on the daemon's machine and ` +
    "run `beevibe-daemon sync`, or start a new chat to use your agent's current runtime."
  );
}

export function failureMessageFor(s: {
  result_summary?: string | null;
  error?: string | null;
}): string {
  const error = s.error?.trim();
  const rewritten = error ? rewriteRuntimeMissingError(error) : undefined;
  if (rewritten) return rewritten;
  if (error && !isBareCliExitMessage(error)) return error;
  const summary = s.result_summary?.trim();
  if (summary && !isBareCliExitMessage(summary)) return summary;
  return DAEMON_LOG_POINTER;
}

function chainToMessages(chain: ConversationChain): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  for (const s of chain.sessions) {
    messages.push({ id: `u_${s.id}`, role: "user", content: s.intent });
    if (s.status === "failed") {
      messages.push({
        id: `a_${s.id}`,
        role: "agent",
        content: failureMessageFor(s),
        session_id: s.id,
      });
      continue;
    }
    const summary = s.result_summary ?? "";
    if (summary) {
      const { visible, view_refs, open_view, suggested_actions } = processResponse(summary);
      messages.push({
        id: `a_${s.id}`,
        role: "agent",
        content: visible,
        session_id: s.id,
        ...(view_refs.length > 0 ? { view_refs } : {}),
        ...(open_view ? { open_view } : {}),
        ...(suggested_actions ? { suggested_actions } : {}),
      });
    }
  }
  return messages;
}

function previewOf(s: ChatSession): string {
  const text = s.result_summary
    ? processResponse(s.result_summary).visible
    : s.error || s.intent;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= CONVERSATION_PREVIEW_CHARS
    ? oneLine
    : oneLine.slice(0, CONVERSATION_PREVIEW_CHARS - 1) + "…";
}

// Hard cap on a single chat turn. AgentSession.run honors abortSignal;
// past this we free the socket + DB connection rather than wait on the
// LLM tail.
const CHAT_TURN_TIMEOUT_MS = 90_000;

interface ChatTurnSession {
  id: string;
  status: string;
  result_summary?: string;
  error?: string;
}

interface ChatTurnAgent {
  id: string;
  name: string;
  hierarchy_level: string;
}

export interface RuntimeMismatch {
  /** CLI this chain is pinned to (the runtime the head session claimed). */
  pinned_cli: KnownCli;
  /** Agent's current CLI per `runtime_config.type`. */
  current_cli: KnownCli;
}

async function detectRuntimeMismatch(
  deps: Pick<ChatRoutesDeps, "runtimeRepo">,
  tailRuntimeId: string | undefined,
  currentCli: KnownCli,
): Promise<RuntimeMismatch | undefined> {
  if (!tailRuntimeId) return undefined;
  const runtime = await deps.runtimeRepo.findById(tailRuntimeId);
  if (!runtime || !isKnownCli(runtime.cli)) return undefined;
  if (runtime.cli === currentCli) return undefined;
  return { pinned_cli: runtime.cli, current_cli: currentCli };
}

/**
 * Build the response body for a chat turn — used by both the live
 * POST success path and the idempotent-replay path. `replayed: true`
 * tells the client this body came from a prior turn's persisted state.
 */
function toChatTurnResponse(
  session: ChatTurnSession,
  agent: ChatTurnAgent,
  opts: { replayed?: boolean } = {},
): Record<string, unknown> {
  const { visible, view_refs, open_view, suggested_actions } = processResponse(
    session.result_summary ?? "",
  );
  // Failed turns get the same friendlier-than-"CLI exited with code 1"
  // treatment as chat history. Success path stays unchanged.
  const response =
    session.status === "failed" ? failureMessageFor(session) : visible || session.error || "";
  return {
    ok: true,
    agent: { id: agent.id, name: agent.name, hierarchy: agent.hierarchy_level },
    session_id: session.id,
    response,
    status: session.status,
    view_refs,
    ...(open_view ? { open_view } : {}),
    ...(suggested_actions ? { suggested_actions } : {}),
    ...(opts.replayed ? { replayed: true } : {}),
  };
}

type ReplayDecision =
  | { kind: "respond"; status: number; body: Record<string, unknown> }
  | { kind: "skip" };

/**
 * Look up an existing chat session for a retry POST and decide what
 * to do. Returns `null` when the row doesn't exist or isn't a chat
 * session — the caller should fall through to the run path.
 *
 * Validates ownership against the agent we already resolved for the
 * caller; mismatch means a session id collision (or token misuse) and
 * the caller gets a 403.
 */
async function tryReplay(
  deps: Pick<ChatRoutesDeps, "sessionRepo">,
  agent: { id: string; name: string; hierarchy_level: string },
  callerSessionId: string,
): Promise<ReplayDecision | null> {
  const existing = await deps.sessionRepo.findById(callerSessionId);
  if (!existing || existing.type !== "chat") return null;
  if (existing.agent_id !== agent.id) {
    return {
      kind: "respond",
      status: 403,
      body: {
        error: "session_belongs_to_other_caller",
        message: "session id collides with a session owned by a different person",
      },
    };
  }
  if (existing.status === "running") {
    return {
      kind: "respond",
      status: 409,
      body: {
        error: "session_in_flight",
        message: "this session is currently running; wait for it to finish",
      },
    };
  }
  if (existing.status === "succeeded" || existing.status === "failed") {
    return {
      kind: "respond",
      status: 200,
      body: toChatTurnResponse(
        {
          id: existing.id,
          status: existing.status,
          result_summary: existing.result_summary ?? undefined,
          error: existing.error ?? undefined,
        },
        agent,
        { replayed: true },
      ),
    };
  }
  return { kind: "skip" };
}

export function createChatRouter(deps: ChatRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);
  // Tests inject their own ChatRateLimiter (deterministic clock); a
  // default ships otherwise.
  const rateLimiter = deps.rateLimiter ?? new ChatRateLimiter();

  router.get("/conversations", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const agent = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
    if (!agent) {
      res.json({ ok: true, conversations: [] });
      return;
    }
    const chats = await deps.sessionRepo.listChatForAgent(agent.id, CHAT_FETCH_LIMIT);
    const chains = groupIntoConversations(chats).slice(0, CONVERSATIONS_LIMIT);

    const conversations = chains.map((chain) => {
      const head = chain.sessions[0]!;
      const last = chain.sessions[chain.sessions.length - 1]!;
      return {
        head_id: chain.head_id,
        title:
          head.intent.length <= 80 ? head.intent : head.intent.slice(0, 79) + "…",
        turn_count: chain.sessions.length,
        last_at: last.created_at.toISOString(),
        last_preview: previewOf(last),
      };
    });
    res.json({ ok: true, conversations });
  });

  // Soft-delete a conversation chain. The repo walks back from the head
  // via `prior_session_id` and stamps `deleted_at` on every session in
  // the chain, scoped to the caller's primary agent so a session id
  // collision (or token misuse) can't delete someone else's history.
  // Idempotent: re-deleting an already-deleted chain returns 200.
  router.delete("/conversations/:headId", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const headId = req.params.headId;
    if (!headId) {
      res.status(400).json({ error: "missing_head_id" });
      return;
    }
    try {
      const agent = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
      if (!agent) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      const deleted = await deps.sessionRepo.softDeleteChatChain(headId, agent.id);
      res.json({ ok: true, deleted });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const agent = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
    if (!agent) {
      res.json({
        ok: true,
        agent: null,
        messages: [],
        prior_session_id: null,
        conversation_id: null,
      });
      return;
    }

    const requestedHead = typeof req.query.c === "string" ? req.query.c : undefined;
    const chats = await deps.sessionRepo.listChatForAgent(agent.id, CHAT_FETCH_LIMIT);
    const chains = groupIntoConversations(chats);

    const chain = requestedHead
      ? chains.find((c) => c.head_id === requestedHead)
      : chains[0]; // most recent

    if (!chain) {
      // Caller asked for a specific conversation that doesn't exist (or has
      // no chat sessions yet). Return empty rather than 404 so the chat UI
      // renders its empty state.
      res.json({
        ok: true,
        agent: { id: agent.id, name: agent.name, hierarchy: agent.hierarchy_level },
        messages: [],
        prior_session_id: null,
        conversation_id: null,
      });
      return;
    }

    const truncated = chain.sessions.slice(-Math.ceil(HISTORY_LIMIT / 2)); // each session = 2 messages
    const messages = chainToMessages({ head_id: chain.head_id, sessions: truncated });
    const latest = chain.sessions[chain.sessions.length - 1]!;
    // Surface the tail session's id when it's still in flight so the
    // chat UI can resume its "agent is thinking" indicator after a
    // navigation away — without this, the local-only `mutation.isPending`
    // gate means the indicator vanishes the moment the user leaves
    // /chat. chainToMessages already skips in-flight sessions (no
    // result_summary, status !== 'failed'), so the user message is
    // present but the agent reply slot is empty until SSE auto-recovery
    // (PR #116) lands the response.
    const inFlightSessionId = isInFlightSessionStatus(latest.status) ? latest.id : undefined;

    // Chains are runtime-pinned: every session in a chain inherits the
    // head's `runtime_id`, and the dispatchService re-pins each
    // continuation via `prior.runtime_id`. So any session in the chain
    // is equivalent for the "what CLI does this chain run on" question.
    // We surface a mismatch to the UI when the agent's currently-
    // configured CLI is different — the next turn WILL still run on the
    // pinned CLI (correct, because resume needs the original .jsonl),
    // but the user should know why their new runtime isn't being used.
    const runtimeMismatch = await detectRuntimeMismatch(
      deps,
      latest.runtime_id,
      agent.runtime_config.type,
    );

    res.json({
      ok: true,
      agent: { id: agent.id, name: agent.name, hierarchy: agent.hierarchy_level },
      messages,
      prior_session_id: latest.id,
      conversation_id: chain.head_id,
      in_flight_session_id: inFlightSessionId,
      ...(runtimeMismatch ? { runtime_mismatch: runtimeMismatch } : {}),
    });
  });

  router.post("/", async (req, res) => {
    if (!requireHuman(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const messageRaw = typeof body.message === "string" ? body.message.trim() : "";
    if (!messageRaw) {
      res.status(400).json({
        error: "message_required",
        message: "POST body must include a non-empty `message: string`",
      });
      return;
    }
    const priorSessionId =
      typeof body.prior_session_id === "string" ? body.prior_session_id : undefined;
    const callerSessionId =
      typeof body.session_id === "string" && /^sess_[A-Za-z0-9]{12}$/.test(body.session_id)
        ? body.session_id
        : undefined;

    // Resolve the caller's primary agent + person row in parallel. The
    // person row carries `onboarding_completed_at` — flipped on the
    // first successful chat turn so the welcome wizard exits.
    const [agent, person] = await Promise.all([
      deps.agentRepo.findTopLevelForOwner(req.caller.personId),
      deps.personRepo.findById(req.caller.personId),
    ]);
    if (!agent) {
      res.status(404).json({
        error: "no_primary_agent",
        message:
          "no team or org agent provisioned for the caller; create one via the CLI before chatting",
      });
      return;
    }

    // Idempotent retry: if the client passed a session_id we already
    // have a row for, replay its persisted result instead of spawning
    // another Claude Code subprocess. Each turn is real $$; this
    // collapses double-submits, browser-cache POST replays, and
    // network-blip retries to a single charge.
    if (callerSessionId) {
      const replay = await tryReplay(deps, agent, callerSessionId);
      if (replay) {
        if (replay.kind === "respond") {
          res.status(replay.status).json(replay.body);
          return;
        }
      }
    }

    // Per-person rate limit (concurrent + sliding window). Compromised
    // tokens / scripted abuse can't drain budget unbounded.
    const rateOutcome = rateLimiter.acquire(req.caller.personId);
    if (!rateOutcome.ok) {
      res
        .status(429)
        .set("Retry-After", String(Math.ceil(rateOutcome.retryAfterMs / 1000)))
        .json({
          error: rateOutcome.reason === "concurrent" ? "turn_in_flight" : "rate_limited",
          message:
            rateOutcome.reason === "concurrent"
              ? "Wait for your previous chat turn to finish before sending another."
              : "Too many chat turns recently. Try again in a moment.",
          retry_after_ms: rateOutcome.retryAfterMs,
        });
      return;
    }

    // Phase 4 daemon-first dispatch. dispatchService inserts a pending
    // session row; the agent's daemon (or executor as null-runtime
    // fallback) claims and spawns. /runtime/done fires the chat resolver
    // we register below — that's what unblocks this POST.
    const reason: ResumeReason = priorSessionId
      ? { kind: "chat_continuation", prior_session_id: priorSessionId }
      : { kind: "fresh" };

    let dispatchResult;
    try {
      dispatchResult = await deps.dispatchService.dispatchTask({
        agentId: agent.id,
        intent: messageRaw,
        reason,
        type: "chat",
        sessionIdOverride: callerSessionId,
      });
    } catch (err) {
      rateOutcome.release();
      handleError(err, res);
      return;
    }

    // Daemon-bound chat with no live daemon → 503; the session sits
    // pending forever and the user gets a clear error rather than a
    // 90-second timeout. Null runtime_id (legacy executor fallback) is
    // fine — the in-process executor claims within ≤30s.
    if (dispatchResult.runtime_id && !deps.hub.isOnline(dispatchResult.runtime_id)) {
      rateOutcome.release();
      res.status(503).json({
        error: "agent_offline",
        message: "Your daemon is offline. Start it with `beevibe-daemon start`.",
      });
      return;
    }

    const wasOnboarding = !person?.onboarding_completed_at;
    try {
      const session = await deps.chatResolver.register(
        dispatchResult.session.id,
        CHAT_TURN_TIMEOUT_MS,
      );

      // First successful onboarding turn — flip the wizard flag. Fire-
      // and-forget so a flaky write doesn't fail the chat response.
      if (wasOnboarding && session.status === "succeeded") {
        deps.personRepo
          .update(req.caller.personId, { onboarding_completed_at: new Date() })
          .catch((err: unknown) =>
            console.error(
              "[chat route] onboarding_completed_at flip failed:",
              err instanceof Error ? err.message : String(err),
            ),
          );
      }

      res.json(
        toChatTurnResponse(
          {
            id: session.id,
            status: session.status,
            result_summary: session.result_summary ?? undefined,
            error: session.error ?? undefined,
          },
          {
            id: agent.id,
            name: agent.name,
            hierarchy_level: agent.hierarchy_level,
          },
        ),
      );
    } catch (err) {
      // ChatResolver.register rejects on its own timeoutMs, no need for
      // a wrapping AbortController here.
      if (err instanceof Error && err.message.includes("timeout")) {
        res.status(504).json({
          error: "chat_turn_timeout",
          message: `Chat turn exceeded ${CHAT_TURN_TIMEOUT_MS / 1000}s and was aborted.`,
          timeout_ms: CHAT_TURN_TIMEOUT_MS,
        });
        return;
      }
      handleError(err, res);
    } finally {
      rateOutcome.release();
    }
  });

  return router;
}
