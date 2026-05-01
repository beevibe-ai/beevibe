/**
 * Human chat surface — `POST /chat`. Resolves the caller's primary
 * (team/org) agent and runs one synchronous AgentSession turn with
 * `type='chat'`. Multi-turn continuity via `prior_session_id` (runtime
 * spawns with `--resume`). Synchronous-only for now; streaming is a
 * follow-up.
 */

import { Router, type RequestHandler, type Response } from "express";
import {
  AgentSession,
  type AgentSessionDeps,
} from "@beevibe/core/services/agent-session";
import type {
  AgentRepository,
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
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  workspaceManager: WorkspaceManager;
  runtimeRegistry: RuntimeRegistry;
  makeMemoryAgent: (agentId: string) => MemoryAgent;
}

function handleError(err: unknown, res: Response): void {
  console.error("[chat route]", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
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

    // Resolve the caller to their primary agent — team-tier preferred, org
    // as fallback. IC agents are intentionally excluded (they're
    // subordinates, not entry points).
    const agent = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
    if (!agent) {
      res.status(404).json({
        error: "no_primary_agent",
        message:
          "no team or org agent provisioned for the caller; create one via the CLI before chatting",
      });
      return;
    }

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
        priorSessionId,
      });

      res.json({
        ok: true,
        agent: { id: agent.id, name: agent.name, hierarchy: agent.hierarchy_level },
        session_id: session.id,
        response: session.result_summary ?? "",
        status: session.status,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}
