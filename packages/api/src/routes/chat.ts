/**
 * Human chat surface — `POST /chat`. Resolves the caller's primary
 * (team/org) agent and runs one synchronous AgentSession turn with
 * `type='chat'`. Multi-turn continuity via `prior_session_id`. The chat
 * UI mints the session id client-side and passes it as `session_id` so
 * it can subscribe to `session.step` SSE events for real-time tool
 * streaming before the run starts.
 *
 * Two structured signals come back alongside the response text:
 *   - `view_refs`: entity ids the agent mentioned, hydrated as cards
 *   - `open_view`: an `<open_view path="..."/>` directive parsed out of
 *     the response so the UI can render a prominent "Open this →" CTA
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
the welcome wizard and you have no memory of them yet. Your job in this
turn:

1. **Greet warmly and briefly.** One short paragraph; don't lecture.
2. **Ask three questions in one message** so they can answer all at once
   or one at a time:
   - What do they do (role, current focus)?
   - What kind of work would they like you to handle?
   - How should you check in when you're unsure (always ask, default to
     a best guess, etc.)?
3. **Use \`update_core_memory\`** to save what you learn into your core
   memory blocks AS the conversation progresses. The user can see those
   writes happen — it's how they know you're listening. Don't wait until
   the end.
4. **At the end of this onboarding conversation** (when you have at
   least the role + work-type signals), suggest 2–3 concrete first
   tasks they might want you to handle, based on what they told you.
   Reference any tasks you mint by their full \`task_*\` id so the UI
   shows them as cards.

Skip the \`<open_view>\` directive on this onboarding turn — the user is
already where they need to be.
`.trim();

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

export function createChatRouter(deps: ChatRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

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
        extraSystemPromptAppend: isOnboarding
          ? `${CHAT_DIRECTIVES}\n\n${ONBOARDING_DIRECTIVES}`
          : CHAT_DIRECTIVES,
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
