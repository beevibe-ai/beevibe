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

export interface ChatRoutesDeps {
  authMiddleware: RequestHandler;
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  workspaceManager: WorkspaceManager;
  runtimeRegistry: RuntimeRegistry;
  makeMemoryAgent: (agentId: string) => MemoryAgent;
}

const ENTITY_ID_RE = /\b((?:task|agent|sess)_[A-Za-z0-9]{12})\b/g;
const OPEN_VIEW_RE =
  /<open_view\s+path="([^"]+)"(?:\s+label="([^"]+)")?\s*\/?>(?:\s*<\/open_view>)?/i;
// Multiple per turn allowed — each becomes a clickable chip below the
// bubble. Tolerates attributes in any order (label first OR prompt
// first), self-closing or paired tags, extra whitespace. Captures the
// whole tag in group 1 so we can re-extract individual attributes.
const SUGGEST_ACTION_RE =
  /<suggest_action\b([^>]*?)\/?>(?:\s*<\/suggest_action>)?/gi;
const ATTR_LABEL_RE = /\blabel\s*=\s*"([^"]*)"/i;
const ATTR_PROMPT_RE = /\bprompt\s*=\s*"([^"]*)"/i;

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

function handleError(err: unknown, res: Response): void {
  console.error("[chat route]", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

export interface SuggestedAction {
  /** Short text shown on the chip. */
  label: string;
  /** Optional fuller text sent on click — defaults to label. */
  prompt?: string;
}

/**
 * Parse out display directives (`<open_view>`, `<suggest_action>`),
 * extract referenced entity ids, and return the cleaned visible
 * response. Directives are stripped from the visible text so the
 * markdown renderer never sees them.
 */
function processResponse(raw: string): {
  visible: string;
  view_refs: string[];
  open_view?: { path: string; label?: string };
  suggested_actions?: SuggestedAction[];
} {
  const openMatch = raw.match(OPEN_VIEW_RE);
  const open_view = openMatch?.[1]
    ? { path: openMatch[1], ...(openMatch[2] ? { label: openMatch[2] } : {}) }
    : undefined;

  const suggestedActions: SuggestedAction[] = [];
  const seenLabels = new Set<string>();
  for (const m of raw.matchAll(SUGGEST_ACTION_RE)) {
    const attrs = m[1] ?? "";
    const label = attrs.match(ATTR_LABEL_RE)?.[1]?.trim();
    const prompt = attrs.match(ATTR_PROMPT_RE)?.[1]?.trim();
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    suggestedActions.push(prompt ? { label, prompt } : { label });
  }
  const suggested_actions = suggestedActions.length > 0 ? suggestedActions : undefined;

  let visible = raw;
  if (openMatch) visible = visible.replace(OPEN_VIEW_RE, "");
  if (suggested_actions) visible = visible.replace(SUGGEST_ACTION_RE, "");
  visible = visible.trim();

  const seen = new Set<string>();
  const view_refs: string[] = [];
  for (const m of visible.matchAll(ENTITY_ID_RE)) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      view_refs.push(id);
    }
  }

  return {
    visible,
    view_refs,
    ...(open_view ? { open_view } : {}),
    ...(suggested_actions ? { suggested_actions } : {}),
  };
}

const HISTORY_LIMIT = 50;
const CONVERSATIONS_LIMIT = 50;
const CONVERSATION_PREVIEW_CHARS = 140;

interface ChatSession {
  id: string;
  prior_session_id?: string;
  intent: string;
  result_summary?: string;
  status: string;
  error?: string;
  created_at: Date;
}

interface ConversationChain {
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
function groupIntoConversations(sessions: readonly ChatSession[]): ConversationChain[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const headOf = new Map<string, string>();
  const findHead = (s: ChatSession): string => {
    const cached = headOf.get(s.id);
    if (cached) return cached;
    const parent = s.prior_session_id ? byId.get(s.prior_session_id) : undefined;
    const head = parent ? findHead(parent) : s.id;
    headOf.set(s.id, head);
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

export function createChatRouter(deps: ChatRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/conversations", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const agent = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
    if (!agent) {
      res.json({ ok: true, conversations: [] });
      return;
    }
    const all = await deps.sessionRepo.listForAgent(agent.id);
    const chats = all.filter((s) => s.type === "chat");
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
    const all = await deps.sessionRepo.listForAgent(agent.id);
    const chats = all.filter((s) => s.type === "chat");
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

    // Resolve caller + their primary agent (team preferred, org fallback)
    // and the person row (for onboarding state) in parallel.
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
    const isOnboarding = !person?.onboarding_completed_at;

    const runtime = deps.runtimeRegistry[agent.runtime_config.type];
    if (!runtime) {
      res.status(500).json({
        error: "unsupported_runtime",
        message: `runtime type '${agent.runtime_config.type}' has no registered adapter`,
      });
      return;
    }

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
        extraSystemPromptAppend: [CHAT_DIRECTIVES, isOnboarding ? ONBOARDING_DIRECTIVES : ""]
          .filter((s) => s.length > 0)
          .join("\n\n"),
      });

      const { visible, view_refs, open_view, suggested_actions } =
        processResponse(session.result_summary ?? "");

      // Mark onboarding complete after the first successful chat turn —
      // fire-and-forget so a slow update can't block the response. The
      // welcome wizard polls `/me` and routes onward when this flips.
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

      res.json({
        ok: true,
        agent: { id: agent.id, name: agent.name, hierarchy: agent.hierarchy_level },
        session_id: session.id,
        response: visible,
        status: session.status,
        view_refs,
        ...(open_view ? { open_view } : {}),
        ...(suggested_actions ? { suggested_actions } : {}),
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}
