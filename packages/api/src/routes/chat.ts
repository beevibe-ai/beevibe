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

const CHAT_DIRECTIVES = `
You are responding inside a chat surface — not a CLI. Two display
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
}

function handleError(err: unknown, res: Response): void {
  console.error("[chat route]", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Parse out the `<open_view path="..." label="..."/>` directive (if any),
 * extract referenced entity ids, and return the cleaned visible response.
 */
function processResponse(raw: string): {
  visible: string;
  view_refs: string[];
  open_view?: { path: string; label?: string };
} {
  const match = raw.match(OPEN_VIEW_RE);
  const open_view = match?.[1]
    ? { path: match[1], ...(match[2] ? { label: match[2] } : {}) }
    : undefined;
  const visible = match ? raw.replace(OPEN_VIEW_RE, "").trim() : raw;

  const seen = new Set<string>();
  const view_refs: string[] = [];
  for (const m of visible.matchAll(ENTITY_ID_RE)) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      view_refs.push(id);
    }
  }

  return open_view ? { visible, view_refs, open_view } : { visible, view_refs };
}

const HISTORY_LIMIT = 50;

export function createChatRouter(deps: ChatRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const agent = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
    if (!agent) {
      // No primary agent yet → no history. Return empty rather than 404
      // so the chat UI can render its empty state instead of crashing.
      res.json({ ok: true, agent: null, messages: [], prior_session_id: null });
      return;
    }

    const all = await deps.sessionRepo.listForAgent(agent.id);
    // Filter to chat-type only and slice to the most recent N. The repo
    // returns DESC by created_at; reverse so the oldest renders first.
    const recent = all.filter((s) => s.type === "chat").slice(0, HISTORY_LIMIT);
    const oldestFirst = [...recent].reverse();

    const messages: HistoryMessage[] = [];
    for (const s of oldestFirst) {
      // User turn — always present (the intent the user typed).
      messages.push({
        id: `u_${s.id}`,
        role: "user",
        content: s.intent,
      });
      // Agent turn — only when the session produced output.
      const summary = s.result_summary ?? "";
      if (summary) {
        const { visible, view_refs, open_view } = processResponse(summary);
        messages.push({
          id: `a_${s.id}`,
          role: "agent",
          content: visible,
          session_id: s.id,
          ...(view_refs.length > 0 ? { view_refs } : {}),
          ...(open_view ? { open_view } : {}),
        });
      } else if (s.status === "failed") {
        // Surface the failure so the user sees what happened on reload
        // instead of a phantom "user said X, agent never replied" gap.
        messages.push({
          id: `a_${s.id}`,
          role: "agent",
          content: s.error || "(turn failed — no response)",
          session_id: s.id,
        });
      }
    }

    res.json({
      ok: true,
      agent: { id: agent.id, name: agent.name, hierarchy: agent.hierarchy_level },
      messages,
      // Latest session id so the next turn chains correctly.
      prior_session_id: oldestFirst.length > 0 ? oldestFirst[oldestFirst.length - 1]!.id : null,
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

      const { visible, view_refs, open_view } = processResponse(session.result_summary ?? "");

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
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}
