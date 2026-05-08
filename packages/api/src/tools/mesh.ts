/**
 * Mesh tools: ask, respond_ask, negotiate, respond_negotiate, report_blocker,
 * escalate_to_humans (6 tools).
 *
 * `add_to_escalation` is NOT here — it's a state-update tool with no spawn
 * or blocking semantics, so it lives alongside update_progress in the
 * hierarchy tool set (M6.4 design).
 */

import { randomUUID } from "node:crypto";
import type { AgentRepository, TaskRepository } from "@beevibe/core";
import type { TaskService } from "@beevibe/core/services/task-service";
import type {
  EscalationService,
  CreateEscalationInput,
} from "@beevibe/core/services/escalation-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { AgentTool, AgentToolResult } from "./types.js";
import type { McpCaller } from "./assemble.js";
import type { MeshServer } from "../mesh/server.js";
import {
  CannotNegotiateWithIcError,
  MeshCapacityError,
  MeshMaxRoundsError,
  type AskResponse,
  type EscalatedSentinel,
  type NegotiateResponse,
} from "../mesh/types.js";

const NEGOTIATE_DECISIONS = ["counter", "accept", "reject"] as const;

export interface MeshToolServices {
  mesh: MeshServer;
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  taskService: TaskService;
  escalationService: EscalationService;
  /** For pg_notify('escalation_created' / 'escalation_updated', id). */
  pool: Pool;
}

export interface MeshToolContext {
  caller: McpCaller;
  /** Caller's beevibe session id (for ask/negotiate originator metadata). */
  beevibeSid: string;
}

function asError(err: unknown, extra: Record<string, unknown> = {}): AgentToolResult {
  if (err instanceof MeshCapacityError) {
    return {
      content: { error: err.code, ...err.meta, message: err.message },
      isError: true,
    };
  }
  if (err instanceof MeshMaxRoundsError) {
    return {
      content: { error: err.code, ...err.meta, message: err.message },
      isError: true,
    };
  }
  if (err instanceof CannotNegotiateWithIcError) {
    return {
      content: { error: err.code, ...err.meta, message: err.message },
      isError: true,
    };
  }
  return {
    content: {
      error: err instanceof Error ? err.message : String(err),
      ...extra,
    },
    isError: true,
  };
}

function projectAskResponse(r: AskResponse): Record<string, unknown> {
  return {
    request_id: r.request_id,
    from_agent_id: r.from_agent_id,
    answer: r.answer,
  };
}

function projectNegotiateResponse(
  r: NegotiateResponse | EscalatedSentinel,
): Record<string, unknown> {
  if (r.decision === "escalated") {
    return {
      decision: "escalated",
      escalation_id: r.escalation_id,
      negotiation_id: r.negotiation_id,
      message: r.message,
    };
  }
  return {
    negotiation_id: r.negotiation_id,
    from_agent_id: r.from_agent_id,
    decision: r.decision,
    message: r.message,
    counter_proposal: r.counter_proposal,
  };
}

// ── ask + respond_ask ────────────────────────────────────────────────────

function askTool(ctx: MeshToolContext, services: MeshToolServices): AgentTool {
  return {
    name: "ask",
    description:
      "Ask another agent a one-shot question that requires their reasoning, " +
      "judgment, or context only they have. Use cases include lateral peer " +
      "queries ('do you think X is feasible?') and downward queries to " +
      "subordinates for context before deciding ('what context do you have " +
      "on project Y before I assign Z?'). Spawns the target's CLI session, " +
      "blocks until they call respond_ask. For STATUS of delegated work, " +
      "use check_work_status — it's a DB read with no session spawn. For " +
      "back-and-forth proposals with stake, use negotiate.",
    schema: {
      type: "object",
      properties: {
        target_agent_id: { type: "string", description: "Agent to ask." },
        question: { type: "string", description: "Your question." },
      },
      required: ["target_agent_id", "question"],
    },
    handler: async (input) => {
      try {
        const target = String(input.target_agent_id ?? "");
        const question = String(input.question ?? "");
        if (!target || !question) {
          return { content: { error: "target_agent_id and question required" }, isError: true };
        }
        const requestId = randomUUID();
        const response = await services.mesh.sendAsk(
          requestId,
          ctx.caller.agentId,
          target,
          question,
        );
        return { content: projectAskResponse(response) };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function respondAskTool(ctx: MeshToolContext, services: MeshToolServices): AgentTool {
  return {
    name: "respond_ask",
    description:
      "Respond to an ask request. Terminal — your session typically exits " +
      "after this call. The asker is unblocked and gets your answer. The " +
      "asker only sees the `answer` arg. Replying via chat alone does NOT " +
      "reach them — you must call this tool.",
    schema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The ask request id (from your session intent)." },
        answer: { type: "string", description: "Your answer to the asker's question." },
      },
      required: ["request_id", "answer"],
    },
    handler: async (input) => {
      try {
        const requestId = String(input.request_id ?? "");
        const answer = String(input.answer ?? "");
        if (!requestId || !answer) {
          return { content: { error: "request_id and answer required" }, isError: true };
        }
        services.mesh.respondAsk(requestId, {
          request_id: requestId,
          from_agent_id: ctx.caller.agentId,
          answer,
        });
        return { content: { responded: true, request_id: requestId } };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

// ── negotiate + respond_negotiate ────────────────────────────────────────

function negotiateTool(ctx: MeshToolContext, services: MeshToolServices): AgentTool {
  return {
    name: "negotiate",
    description:
      "Start a negotiation with a peer agent (round 1 only). Spawns the peer " +
      "and blocks until they respond. After round 1, both sides use " +
      "respond_negotiate to alternate. Server enforces a hard max-rounds cap " +
      "(default 5, per-agent configurable); on max_rounds_exceeded, call " +
      "escalate_to_humans instead. Target must be team or org tier — " +
      "calling against an IC returns cannot_negotiate_with_ic. ICs are " +
      "workers; for downward delegation use create_task.",
    schema: {
      type: "object",
      properties: {
        peer_id: { type: "string", description: "The peer agent to negotiate with." },
        proposal: { type: "string", description: "Your initial proposal." },
        task_id: {
          type: "string",
          description: "Task this negotiation pertains to (optional). Stamped on the negotiation row + on the eventual escalation if any.",
        },
      },
      required: ["peer_id", "proposal"],
    },
    handler: async (input) => {
      try {
        const peerId = String(input.peer_id ?? "");
        const proposal = String(input.proposal ?? "");
        const taskId =
          typeof input.task_id === "string" && input.task_id ? input.task_id : undefined;
        if (!peerId || !proposal) {
          return { content: { error: "peer_id and proposal required" }, isError: true };
        }

        const response = await services.mesh.sendNegotiate(
          ctx.caller.agentId,
          peerId,
          proposal,
          { taskId, initiatorSessionId: ctx.beevibeSid },
        );
        return { content: projectNegotiateResponse(response) };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function respondNegotiateTool(ctx: MeshToolContext, services: MeshToolServices): AgentTool {
  return {
    name: "respond_negotiate",
    description:
      "Respond in a negotiation round. Used by both sides after round 1. " +
      "If decision='counter', you'll block until the peer's next reply. If " +
      "accept/reject, the negotiation is terminal and you should exit. If " +
      "the next round would exceed max_rounds, call escalate_to_humans " +
      "instead — a max_rounds_exceeded error will surface here.",
    schema: {
      type: "object",
      properties: {
        negotiation_id: { type: "string", description: "Negotiation id (from your session intent)." },
        decision: {
          type: "string",
          enum: [...NEGOTIATE_DECISIONS],
          description: "counter / accept / reject.",
        },
        message: { type: "string", description: "Free-form message to the peer." },
        counter_proposal: {
          type: "string",
          description: "Required when decision='counter' — your alternative proposal.",
        },
      },
      required: ["negotiation_id", "decision", "message"],
    },
    handler: async (input) => {
      try {
        const negId = String(input.negotiation_id ?? "");
        const decision = input.decision as (typeof NEGOTIATE_DECISIONS)[number];
        const message = String(input.message ?? "");
        const counter =
          typeof input.counter_proposal === "string" ? input.counter_proposal : undefined;

        if (!negId || !message) {
          return { content: { error: "negotiation_id and message required" }, isError: true };
        }
        if (!NEGOTIATE_DECISIONS.includes(decision)) {
          return {
            content: { error: `decision must be one of: ${NEGOTIATE_DECISIONS.join(", ")}` },
            isError: true,
          };
        }
        if (decision === "counter" && !counter) {
          return {
            content: { error: "counter_proposal required when decision='counter'" },
            isError: true,
          };
        }

        // The server computes the round number internally from
        // negotiation.rounds_completed; agents don't pass it.
        const result = await services.mesh.respondNegotiate(
          negId,
          {
            negotiation_id: negId,
            from_agent_id: ctx.caller.agentId,
            decision,
            message,
            counter_proposal: counter,
          },
          ctx.beevibeSid,
        );

        if (result === null) {
          // Terminal — accept/reject. Caller exits.
          return { content: { negotiation_id: negId, decision, terminal: true } };
        }
        return { content: projectNegotiateResponse(result) };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

// ── report_blocker (fire-and-forget) ─────────────────────────────────────

function reportBlockerTool(ctx: MeshToolContext, services: MeshToolServices): AgentTool {
  return {
    name: "report_blocker",
    description:
      "Report a blocker to your direct parent agent. Marks the task as " +
      "blocked with you as the blocker_agent_id and spawns the parent's " +
      "session asynchronously to investigate. After this call, exit your " +
      "session — the executor will re-dispatch you with the parent's " +
      "guidance via revise_task. Top-level agents (no parent) should not " +
      "call this — use escalate_to_humans or update_progress('failed') " +
      "instead.",
    schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task you're blocked on." },
        description: { type: "string", description: "What's blocking you and what you've tried." },
      },
      required: ["task_id", "description"],
    },
    handler: async (input) => {
      try {
        const taskId = String(input.task_id ?? "");
        const description = String(input.description ?? "");
        if (!taskId || !description) {
          return {
            content: { error: "task_id and description required" },
            isError: true,
          };
        }

        // Server derives parent from caller's hierarchy. Direct parent only.
        const parent = await services.agentRepo.findParent(ctx.caller.agentId);
        if (!parent) {
          return {
            content: {
              error: "no_parent_to_block",
              message:
                "Top-level agents have no parent to report blockers to. Use escalate_to_humans or update_progress('failed') instead.",
            },
            isError: true,
          };
        }

        // Mark the task blocked + record the blocker_agent_id + reason.
        await services.taskService.markBlocked(taskId, ctx.caller.agentId, description);

        // Fire-and-forget spawn parent's session.
        services.mesh.reportBlocker(parent.id, ctx.caller.agentId, taskId, description);

        return {
          content: {
            reported: true,
            parent_agent_id: parent.id,
            task_id: taskId,
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

// ── escalate_to_humans ───────────────────────────────────────────────────

function escalateToHumansTool(
  ctx: MeshToolContext,
  services: MeshToolServices,
): AgentTool {
  return {
    name: "escalate_to_humans",
    description:
      "Initiate an escalation — hand off a stuck negotiation to humans for " +
      "resolution. Creates an escalation row, marks the negotiation 'escalated', " +
      "blocks the task (if any), and unblocks your peer's pending " +
      "respond_negotiate with an 'escalated' sentinel so they can call " +
      "add_to_escalation with their perspective. Submit your proposals + " +
      "open questions for the human reviewer. Call this when negotiations " +
      "stall or hit max_rounds_exceeded — humans pick from your proposals " +
      "(or invent their own) via POST /escalation/:id/resolve. After this " +
      "call, exit your session — the human will resolve and the executor " +
      "will re-dispatch you with the resolution as post-escalation context.",
    schema: {
      type: "object",
      properties: {
        negotiation_id: { type: "string", description: "Negotiation to escalate." },
        summary: {
          type: "string",
          description:
            "Single shared problem statement. Neutral phrasing — \"We're stuck on X; root disagreement is Y.\" Becomes the escalation row's summary; immutable thereafter (peer's add_to_escalation can't change it).",
        },
        proposals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              tradeoffs: { type: "string" },
            },
            required: ["title", "description"],
          },
          description: "Your concrete options for the human (2-3 typical).",
        },
        open_questions: {
          type: "array",
          items: { type: "string" },
          description: "Things the human might know that you don't.",
        },
      },
      required: ["negotiation_id", "summary"],
    },
    handler: async (input) => {
      try {
        const negotiationId = String(input.negotiation_id ?? "");
        const summary = String(input.summary ?? "");
        if (!negotiationId || !summary) {
          return { content: { error: "negotiation_id and summary required" }, isError: true };
        }

        const proposals = Array.isArray(input.proposals)
          ? (input.proposals as CreateEscalationInput["proposals"])
          : undefined;
        const openQuestions = Array.isArray(input.open_questions)
          ? (input.open_questions as string[]).filter((q) => typeof q === "string")
          : undefined;

        const escalation = await services.escalationService.create({
          negotiationId,
          callerAgentId: ctx.caller.agentId,
          summary,
          proposals,
          openQuestions,
        });

        // Sentinel-unblock the peer's pending respond_negotiate (if any).
        services.mesh.unblockOnEscalate(negotiationId, escalation.id);

        // pg_notify for future M8 web UI subscribers (zero cost in M6).
        await services.pool.query(`SELECT pg_notify('escalation_created', $1)`, [
          escalation.id,
        ]);

        return {
          content: {
            escalation_id: escalation.id,
            status: escalation.status,
            negotiation_id: escalation.negotiation_id,
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

// ── Assemble mesh tool sets ──────────────────────────────────────────────

/**
 * IC tier mesh tools (M9.1). ICs are workers, not deciders — they don't
 * INITIATE coordination and they don't participate in multi-round
 * negotiations as peers. They DO answer one-shot questions (team-tier
 * agents can target ICs with `ask`) and they CAN escalate upward via
 * `report_blocker`.
 *
 * Excluded from IC tier:
 *   - `ask` / `negotiate` — initiation is team/org only
 *   - `respond_negotiate` — M9.1 server guardrail rejects negotiate
 *     against IC targets, so the IC is never spawned as a negotiation
 *     peer; the tool would be unreachable
 *   - `escalate_to_humans` — escalation is for stuck negotiations
 *     (initiator-only) and ICs don't initiate
 */
export function buildIcMeshTools(
  ctx: MeshToolContext,
  services: MeshToolServices,
): AgentTool[] {
  return [
    respondAskTool(ctx, services),
    reportBlockerTool(ctx, services),
  ];
}

/**
 * Team/org mesh tools — all 6. Team agents initiate negotiations + asks
 * with peers, respond when others spawn them, report blockers up to org-
 * tier, and escalate stuck negotiations to humans.
 */
export function buildTeamMeshTools(
  ctx: MeshToolContext,
  services: MeshToolServices,
): AgentTool[] {
  return [
    askTool(ctx, services),
    respondAskTool(ctx, services),
    negotiateTool(ctx, services),
    respondNegotiateTool(ctx, services),
    reportBlockerTool(ctx, services),
    escalateToHumansTool(ctx, services),
  ];
}
