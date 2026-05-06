/**
 * Human chat surface.
 *
 * `POST /chat`: resolves the caller's primary (team/org) agent and runs
 * one synchronous AgentSession turn with `type='chat'`. Multi-turn
 * continuity via `prior_session_id`. The chat UI mints the session id
 * client-side and passes it as `session_id` so it can subscribe to
 * `session.step` SSE events for real-time tool streaming before the run
 * starts. Response carries:
 *   - `view_refs`: entity ids the agent mentioned, hydrated as cards
 *   - `open_view`: an `<open_view path="..."/>` directive parsed out of
 *     the response so the UI can render a prominent "Open this →" CTA
 *
 * `GET /chat`: returns the last N chat sessions for the caller's primary
 * agent, reconstructed as `{role, content, session_id, view_refs?,
 * open_view?}` messages so the chat surface can rehydrate after a
 * reload. Sessions are persisted server-side (the `session` table); the
 * client just lost its component-state copy of the conversation.
 */

import { randomUUID } from "node:crypto";
import { Router, type RequestHandler, type Response } from "express";
import {
  AgentSession,
  type AgentSessionDeps,
} from "@beevibe/core/services/agent-session";
import type {
  AgentRepository,
  PersonRepository,
  RuntimeRegistry,
  SessionEventRepository,
  SessionRepository,
  WorkspaceManager,
} from "@beevibe/core";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import { requireHuman } from "../auth/middleware.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { processResponse, type SuggestedAction } from "./directives.js";

export interface ChatRoutesDeps {
  authMiddleware: RequestHandler;
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  workspaceManager: WorkspaceManager;
  runtimeRegistry: RuntimeRegistry;
  makeMemoryAgent: (agentId: string) => MemoryAgent;
  /** Optional override; tests inject one with a deterministic clock. */
  rateLimiter?: ChatRateLimiter;
}

const CHAT_DIRECTIVES = `
You are responding inside a chat surface — not a CLI. Three display
directives the UI understands:

1. **Reference any task / agent / session by its full id** (e.g.
   \`task_abc123def456\`) inline in your response. The UI hydrates
   each id as a clickable card linking to the detail page.

2. **When the user clearly wants to land on a specific page** (e.g.
   "show me the mesh", "open the billing task"), end your response
   with one directive on its own line:

   \`<open_view path="/the/path" label="Optional CTA label" />\`

   Valid paths: \`/tasks\`, \`/tasks/<task_id>\`, \`/agents\`,
   \`/agents/<agent_id>\`, \`/mesh\`, \`/memory\`, \`/promotions\`,
   \`/dashboard\`. The UI renders this as a prominent "Open this →"
   button below your message and strips the directive from the visible
   text. Use this sparingly — only when the user's intent is clearly
   navigational, not for every mention.

3. **When you offer the user concrete next steps** (typically 2–4
   focused options at the end of a turn), append one
   \`<suggest_action>\` directive per option on its own line:

   \`<suggest_action label="Approve as-is and spin up the team" />\`

   Optionally pair with a longer \`prompt\` attribute — the chip
   shows \`label\`, but clicking sends \`prompt\` as the user's next
   message:

   \`<suggest_action label="Approve" prompt="Approve as-is and spin up all three specialists now." />\`

   Keep \`label\` short (under ~80 chars). Skip the chips entirely
   when there's nothing concrete to choose.
`.trim();

const ONBOARDING_DIRECTIVES = `
This is the user's FIRST EVER chat with you. They have just finished
the welcome wizard and you have no memory of them yet. Don't ask
abstract questions about their role or working style — drive the
conversation toward CONCRETE WORK ON A REAL CODEBASE.

Your job over the next few turns:

1. **Greet briefly (one short paragraph) and immediately propose a
   collaboration model**: you build a small team of specialist
   subordinate agents who each own part of the codebase, then each one
   takes on real tasks. Make this concrete — the user shouldn't have to
   guess what you can do.

2. **Ask the user to point you at a codebase or repo.** A path on disk,
   a GitHub repo, or "this monorepo we're already in". If they don't
   have one yet, ask what they're trying to build and skip ahead — you
   can still spawn specialists for greenfield work.

3. **Explore the code yourself before proposing a team.** You have
   \`Bash\`, \`Read\`, \`Glob\`, \`Grep\` available — use them. Read the
   README / package.json / main entry points. Don't ask the user to
   describe the stack; figure it out, then confirm.

4. **Propose 2–3 specialists tailored to what you saw.** Examples:
   "Backend specialist (covers \`packages/api\`, Postgres, MCP tools)",
   "Frontend specialist (covers \`packages/web\`, Next.js, design
   system)". Concrete > generic — name the actual files / dirs each
   agent owns. Confirm with the user, then call
   \`create_subordinate_agent\` once per specialist with a focused
   \`persona\` and \`domain\` block.

5. **Mint a real first task for at least one specialist.** Use
   \`create_task\` with a tightly-scoped intent the user agreed on
   ("audit packages/api for unused exports", "draft a README for
   packages/web"). Reference the resulting \`task_*\` id in your reply —
   the UI hydrates it as a clickable card.

6. **Use \`update_core_memory\`** as you go to record what you learned
   about the user, the codebase, and the team you assembled. The user
   sees those writes happen in real time — that's how they know you're
   actually listening, not just LLM-stalling.

7. **End every turn with 2–4 \`<suggest_action>\` chips** that give the
   user concrete next moves (especially during onboarding). Examples
   for the team-proposal turn:

   \`<suggest_action label="Approve as-is and spin up all three" />\`
   \`<suggest_action label="Merge backend + services into one specialist" />\`
   \`<suggest_action label="Add a docs/strategy specialist" />\`

   Labels become the user's next message verbatim, so write them as
   first-person actions the agent can act on directly.

Skip the \`<open_view>\` directive on this onboarding turn — the user is
already where they need to be.
`.trim();

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

function chainToMessages(chain: ConversationChain): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  for (const s of chain.sessions) {
    messages.push({ id: `u_${s.id}`, role: "user", content: s.intent });
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
    } else if (s.status === "failed") {
      messages.push({
        id: `a_${s.id}`,
        role: "agent",
        content: s.error || "(turn failed — no response)",
        session_id: s.id,
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
  return {
    ok: true,
    agent: { id: agent.id, name: agent.name, hierarchy: agent.hierarchy_level },
    session_id: session.id,
    response: visible || session.error || "",
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

    res.json({
      ok: true,
      agent: { id: agent.id, name: agent.name, hierarchy: agent.hierarchy_level },
      messages,
      // Latest session id so the next turn chains correctly.
      prior_session_id: chain.sessions[chain.sessions.length - 1]!.id,
      conversation_id: chain.head_id,
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

    // Resolve the caller's primary agent + their person row up front
    // (parallel). The agent is needed everywhere downstream — replay
    // path verifies ownership against it, run path uses it as the
    // session's agent.
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

    const isOnboarding = !person?.onboarding_completed_at;
    const runtime = deps.runtimeRegistry[agent.runtime_config.type];
    if (!runtime) {
      rateOutcome.release();
      res.status(500).json({
        error: "unsupported_runtime",
        message: `runtime type '${agent.runtime_config.type}' has no registered adapter`,
      });
      return;
    }

    const abortController = new AbortController();
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, CHAT_TURN_TIMEOUT_MS);

    try {
      const workspace = await deps.workspaceManager.ensureWorkspace({ agent });
      const agentSessionDeps: AgentSessionDeps = {
        agentRepo: deps.agentRepo,
        sessionRepo: deps.sessionRepo,
        sessionEventRepo: deps.sessionEventRepo,
        runtime,
        memoryAgent: deps.makeMemoryAgent(agent.id),
      };
      const agentSession = new AgentSession(agentSessionDeps);

      const session = await agentSession.run({
        agentId: agent.id,
        intent: messageRaw,
        workspace,
        type: "chat",
        sessionId: callerSessionId,
        priorSessionId,
        abortSignal: abortController.signal,
        extraSystemPromptAppend: [CHAT_DIRECTIVES, isOnboarding ? ONBOARDING_DIRECTIVES : ""]
          .filter((s) => s.length > 0)
          .join("\n\n"),
      });

      // Onboarding state flip — fire-and-forget. Welcome wizard polls
      // `/me` and routes onward when this lands.
      if (isOnboarding && session.status === "succeeded") {
        deps.personRepo
          .update(req.caller.personId, { onboarding_completed_at: new Date() })
          .catch((err) =>
            console.error(
              "[chat route] onboarding_completed_at update failed:",
              (err as Error).message,
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
      if (timedOut) {
        res.status(504).json({
          error: "chat_turn_timeout",
          message: `Chat turn exceeded ${CHAT_TURN_TIMEOUT_MS / 1000}s and was aborted.`,
          timeout_ms: CHAT_TURN_TIMEOUT_MS,
        });
        return;
      }
      handleError(err, res);
    } finally {
      clearTimeout(timeoutTimer);
      rateOutcome.release();
    }
  });

  return router;
}
