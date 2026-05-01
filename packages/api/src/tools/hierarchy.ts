/**
 * Hierarchy / task / work-product tools — M6.3.
 *
 * 12 tools that operate on the agent-task hierarchy. Split by tier:
 *
 *   IC (5 tools):
 *     search_context, update_progress, find_up, get_agent_profile, get_task,
 *     create_work_product, list_work_products, update_work_product
 *     (8 actually — work-product trio is IC+team since ICs do the work)
 *
 *   Team / org (12 tools):
 *     all of IC plus find_subordinates, find_peers, create_task,
 *     check_work_status
 *
 * M6.4 adds `revise_task` (13th) to this file with parent-only authz.
 *
 * Pattern matches old intentcore `hierarchy-tools.ts`. Old code referenced
 * a `ContextProvider` abstraction; we go straight to AgentRepository
 * (M1) + new findParent (M6.3).
 */

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  WORK_PRODUCT_TYPES,
  taskId as makeTaskId,
  workProductId as makeWorkProductId,
  type Agent,
  type AgentRepository,
  type HierarchyLevel,
  type Task,
  type TaskRepository,
  type TaskStatus,
  type WorkProductRepository,
} from "@beevibe/core";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  type TaskService,
  InvalidTaskTransitionError,
} from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import type { AgentTool, AgentToolResult } from "./types.js";

// ── Agent-callable status subsets ─────────────────────────────────────────
//
// The full TaskStatus space includes states agents must NOT self-assign:
//   - 'review'         is gated by the review_policy in TaskService
//   - 'needs_revision' is set by humans via /task/:id/revise
//   - 'in_progress'    is set by the executor's claim
//   - 'revision'       is set by the executor when claiming needs_revision
//   - 'cancelled'      is operator-driven via /task/:id/cancel (or rejectTask)
//   - 'assigned' / 'pending' are pre-dispatch states
// Agents only set END states. The TaskService.updateProgress applies the
// review_policy gate which can rewrite 'done' → 'review'; that's a
// platform-internal transition, not something the agent declared.

const AGENT_END_STATUSES = ["done", "failed", "blocked"] as const satisfies readonly TaskStatus[];
type AgentEndStatus = (typeof AGENT_END_STATUSES)[number];

// ── Shared services + context ────────────────────────────────────────────

export interface HierarchyToolServices {
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  workProductRepo: WorkProductRepository;
  taskService: TaskService;
  /** For search_context — lets the agent re-query archival memory mid-session. */
  memoryAgent: MemoryAgent;
  /** M6.4: backs `revise_task` (parent unblocks subordinate via reviseTask). */
  // (taskService.reviseTask is the actual call; same dep as above.)

  /** M6.4: backs `add_to_escalation` (peer adds their slot to existing row). */
  escalationService: EscalationService;
  /** M6.4: pg_notify on add_to_escalation for future M8 web subscribers. */
  pool: Pool;
}

export interface HierarchyToolContext {
  /** The caller's resolved agent id. Tools that act "for me" use this. */
  agentId: string;
  /** Caller's hierarchy level. Used to pick the IC vs team tool set. */
  hierarchyLevel: HierarchyLevel;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function projectAgent(agent: Agent | undefined): Record<string, unknown> | null {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    hierarchy_level: agent.hierarchy_level,
    parent_agent_id: agent.parent_agent_id ?? null,
    owner_id: agent.owner_id,
  };
}

function projectTask(task: Task | undefined): Record<string, unknown> | null {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    assignee_id: task.assignee_id ?? null,
    creator_id: task.creator_id,
    creator_type: task.creator_type,
    parent_task_id: task.parent_task_id ?? null,
    result_summary: task.result_summary ?? null,
    blocker_agent_id: task.blocker_agent_id ?? null,
    blocker_reason: task.blocker_reason ?? null,
    created_at: task.created_at.toISOString(),
    updated_at: task.updated_at.toISOString(),
  };
}

function asError(err: unknown): AgentToolResult {
  return {
    content: {
      error: err instanceof Error ? err.message : String(err),
    },
    isError: true,
  };
}

// ── Shared (IC + team) tools ─────────────────────────────────────────────

function searchContextTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "search_context",
    description:
      "Re-query your archival memory for facts relevant to a topic. The " +
      "session-start briefing already contains top-k facts, but use this " +
      "tool when you need to recall facts on a specific topic during the " +
      "session (e.g., \"what did we decide about X for project Y?\").",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The topic or question to search for in archival memory.",
        },
      },
      required: ["query"],
    },
    handler: async (input) => {
      try {
        const query = String(input.query ?? "").trim();
        if (!query) {
          return { content: { error: "query must be a non-empty string" }, isError: true };
        }
        // prepareBriefing returns the full <core_memory> + <archival_memory>
        // XML; for an in-session re-query we only need the archival side, but
        // the cost of returning the whole envelope is cheap and it gives the
        // agent the same shape they saw at session start.
        const briefing = await services.memoryAgent.prepareBriefing(query);
        return { content: { briefing: briefing.systemPromptAppend } };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function updateProgressTool(
  _ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "update_progress",
    description:
      "Set a task's FINAL status. Call this when you are DONE with the task. " +
      "Allowed values: 'done' (completed), 'failed' (cannot complete), " +
      "'blocked' (requires intervention; pair with report_blocker if you " +
      "need a parent agent to unblock you). Do NOT use this to set " +
      "'in_progress' — the platform sets that automatically when your " +
      "session starts. The platform's review_policy may rewrite 'done' to " +
      "'review' if a human reviewer is required.",
    schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task to update." },
        status: {
          type: "string",
          enum: [...AGENT_END_STATUSES],
          description: "Final agent-declared status.",
        },
        summary: {
          type: "string",
          description: "Brief description of what was done (or why it failed/blocked).",
        },
      },
      required: ["task_id", "status", "summary"],
    },
    handler: async (input) => {
      try {
        const taskId = String(input.task_id ?? "");
        const status = input.status as AgentEndStatus;
        const summary = String(input.summary ?? "");
        if (!AGENT_END_STATUSES.includes(status)) {
          return {
            content: {
              error: `status must be one of: ${AGENT_END_STATUSES.join(", ")}`,
            },
            isError: true,
          };
        }
        const updated = await services.taskService.updateProgress(taskId, status, summary);
        return {
          content: {
            updated: true,
            task_id: updated.id,
            status: updated.status,
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function findUpTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "find_up",
    description:
      "Find your direct parent agent in the hierarchy. Returns null for " +
      "top-level agents (no parent).",
    schema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const parent = await services.agentRepo.findParent(ctx.agentId);
        return { content: { parent: projectAgent(parent) } };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function getAgentProfileTool(
  _ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "get_agent_profile",
    description:
      "Look up a specific agent's profile by id. Returns null if the agent " +
      "doesn't exist.",
    schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent to look up." },
      },
      required: ["agent_id"],
    },
    handler: async (input) => {
      try {
        const id = String(input.agent_id ?? "");
        if (!id) return { content: { error: "agent_id required" }, isError: true };
        const agent = await services.agentRepo.findById(id);
        return { content: { agent: projectAgent(agent) } };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function getTaskTool(
  _ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "get_task",
    description: "Look up a task by id. Returns null if not found.",
    schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task to look up." },
      },
      required: ["task_id"],
    },
    handler: async (input) => {
      try {
        const id = String(input.task_id ?? "");
        if (!id) return { content: { error: "task_id required" }, isError: true };
        const task = await services.taskRepo.findById(id);
        return { content: { task: projectTask(task) } };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

// ── Work-product tools (IC + team — ICs do the actual work) ──────────────

function createWorkProductTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "create_work_product",
    description:
      "Record a deliverable produced for a task — a PR, branch, commit, " +
      "document, design, analysis, report, artifact, or preview. Before " +
      "creating, call list_work_products(task_id) to check whether the " +
      "deliverable already exists (use update_work_product to amend an " +
      "existing one with the same identity, e.g. same PR URL).",
    schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task this output belongs to." },
        type: {
          type: "string",
          enum: [...WORK_PRODUCT_TYPES],
          description: "Kind of work product.",
        },
        title: { type: "string", description: "Title of the work product." },
        url: { type: "string", description: "Link to the deliverable (e.g. GitHub PR URL)." },
        summary: { type: "string", description: "What was produced; capture the why + what changed." },
        provider: { type: "string", description: "Where it's hosted (github, notion, figma, etc)." },
        external_id: { type: "string", description: "External id (PR number, doc id, etc)." },
        metadata: { type: "object", description: "Additional structured fields." },
      },
      required: ["task_id", "type", "title"],
    },
    handler: async (input) => {
      try {
        const taskId = String(input.task_id ?? "");
        const type = input.type;
        const title = String(input.title ?? "");
        if (!taskId || !title) {
          return {
            content: { error: "task_id and title required" },
            isError: true,
          };
        }
        if (!WORK_PRODUCT_TYPES.includes(type as (typeof WORK_PRODUCT_TYPES)[number])) {
          return {
            content: { error: `type must be one of: ${WORK_PRODUCT_TYPES.join(", ")}` },
            isError: true,
          };
        }
        const wp = await services.taskService.createWorkProduct({
          id: makeWorkProductId(),
          task_id: taskId,
          agent_id: ctx.agentId,
          type: type as (typeof WORK_PRODUCT_TYPES)[number],
          title,
          summary: typeof input.summary === "string" ? input.summary : undefined,
          url: typeof input.url === "string" ? input.url : undefined,
          provider: typeof input.provider === "string" ? input.provider : undefined,
          external_id: typeof input.external_id === "string" ? input.external_id : undefined,
          metadata:
            input.metadata && typeof input.metadata === "object"
              ? (input.metadata as Record<string, unknown>)
              : undefined,
        });
        return {
          content: {
            created: { id: wp.id, type: wp.type, title: wp.title, task_id: wp.task_id },
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function listWorkProductsTool(
  _ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "list_work_products",
    description:
      "List existing work products for a task in chronological order. Call " +
      "this BEFORE create_work_product to check if you should update an " +
      "existing deliverable (same identity / URL) instead of creating a " +
      "duplicate row.",
    schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task whose work products to list." },
      },
      required: ["task_id"],
    },
    handler: async (input) => {
      try {
        const taskId = String(input.task_id ?? "");
        if (!taskId) return { content: { error: "task_id required" }, isError: true };
        const wps = await services.taskService.listWorkProducts(taskId);
        return {
          content: {
            work_products: wps.map((w) => ({
              id: w.id,
              type: w.type,
              title: w.title,
              url: w.url ?? null,
              summary: w.summary ?? null,
              created_at: w.created_at.toISOString(),
              updated_at: w.updated_at.toISOString(),
            })),
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function updateWorkProductTool(
  _ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "update_work_product",
    description:
      "Amend an existing work product — useful when the same deliverable " +
      "evolved (PR got new commits, doc revised, summary needs updating). " +
      "Identity fields (type, title, task_id, agent_id) are immutable; " +
      "only summary, url, provider, external_id, and metadata can change. " +
      "Use list_work_products(task_id) to find the right id first.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The work_product id to amend." },
        summary: { type: "string", description: "Updated summary." },
        url: { type: "string", description: "Updated URL." },
        provider: { type: "string", description: "Updated provider." },
        external_id: { type: "string", description: "Updated external id." },
        metadata: { type: "object", description: "Updated metadata blob." },
      },
      required: ["id"],
    },
    handler: async (input) => {
      try {
        const id = String(input.id ?? "");
        if (!id) return { content: { error: "id required" }, isError: true };
        const updated = await services.taskService.updateWorkProduct(id, {
          summary: typeof input.summary === "string" ? input.summary : undefined,
          url: typeof input.url === "string" ? input.url : undefined,
          provider: typeof input.provider === "string" ? input.provider : undefined,
          external_id:
            typeof input.external_id === "string" ? input.external_id : undefined,
          metadata:
            input.metadata && typeof input.metadata === "object"
              ? (input.metadata as Record<string, unknown>)
              : undefined,
        });
        return {
          content: {
            updated: {
              id: updated.id,
              type: updated.type,
              title: updated.title,
              updated_at: updated.updated_at.toISOString(),
            },
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

// ── Team-only tools ──────────────────────────────────────────────────────

function findSubordinatesTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "find_subordinates",
    description:
      "List your direct subordinate agents (the IC agents reporting to you).",
    schema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const subs = await services.agentRepo.findSubordinates(ctx.agentId);
        return { content: { agents: subs.map(projectAgent) } };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function findPeersTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "find_peers",
    description:
      "List your peer agents — same hierarchy level, same parent. Useful " +
      "for cross-team coordination via the mesh tools (ask, negotiate).",
    schema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const peers = await services.agentRepo.findPeers(ctx.agentId);
        return { content: { agents: peers.map(projectAgent) } };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function createTaskTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "create_task",
    description:
      "Create a task and assign it to one of your subordinates. The task " +
      "is inserted at status='assigned' so the executor picks it up. Use " +
      "find_subordinates first to choose the right agent. If this is a " +
      "sub-task of one you're working on, pass parent_task_id so the " +
      "parent auto-completes when all subtasks finish.",
    schema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "What the task requires (becomes title)." },
        description: { type: "string", description: "Optional longer description." },
        agent_id: { type: "string", description: "Subordinate agent to assign the task to." },
        priority: {
          type: "string",
          enum: [...TASK_PRIORITIES],
          description: "Task priority. Default: medium.",
        },
        parent_task_id: { type: "string", description: "Parent task for auto-rollup." },
      },
      required: ["intent", "agent_id"],
    },
    handler: async (input) => {
      try {
        const intent = String(input.intent ?? "");
        const targetId = String(input.agent_id ?? "");
        if (!intent || !targetId) {
          return {
            content: { error: "intent and agent_id required" },
            isError: true,
          };
        }

        // Authz: assignee must be one of caller's subordinates.
        const subs = await services.agentRepo.findSubordinates(ctx.agentId);
        if (!subs.some((s) => s.id === targetId)) {
          return {
            content: {
              error: "not_subordinate",
              message: `Cannot assign tasks to ${targetId} — not a direct subordinate of ${ctx.agentId}.`,
            },
            isError: true,
          };
        }

        const priority = (input.priority as (typeof TASK_PRIORITIES)[number]) ?? "medium";
        if (!TASK_PRIORITIES.includes(priority)) {
          return {
            content: { error: `priority must be one of: ${TASK_PRIORITIES.join(", ")}` },
            isError: true,
          };
        }

        const created = await services.taskRepo.create({
          id: makeTaskId(),
          title: intent,
          description: typeof input.description === "string" ? input.description : undefined,
          status: "assigned",
          priority,
          assignee_id: targetId,
          creator_id: ctx.agentId,
          creator_type: "agent",
          parent_task_id:
            typeof input.parent_task_id === "string" ? input.parent_task_id : undefined,
        });
        return {
          content: {
            created: {
              id: created.id,
              title: created.title,
              status: created.status,
              assignee_id: created.assignee_id,
            },
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

function checkWorkStatusTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "check_work_status",
    description:
      "Check task status for yourself or one of your subordinates. Returns " +
      "all of that agent's tasks plus a per-status count summary.",
    schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent whose tasks to check (yourself or a subordinate)." },
      },
      required: ["agent_id"],
    },
    handler: async (input) => {
      try {
        const targetId = String(input.agent_id ?? "");
        if (!targetId) return { content: { error: "agent_id required" }, isError: true };

        // Authz: self or direct subordinate.
        if (targetId !== ctx.agentId) {
          const subs = await services.agentRepo.findSubordinates(ctx.agentId);
          if (!subs.some((s) => s.id === targetId)) {
            return {
              content: {
                error: "unauthorized",
                message: `Can only check work status for self or a direct subordinate.`,
              },
              isError: true,
            };
          }
        }

        const tasks = await services.taskRepo.listByAssignee(targetId);
        const counts: Record<TaskStatus, number> = Object.fromEntries(
          TASK_STATUSES.map((s) => [s, 0]),
        ) as Record<TaskStatus, number>;
        for (const t of tasks) counts[t.status] += 1;
        return {
          content: {
            agent_id: targetId,
            counts,
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
              created_at: t.created_at.toISOString(),
            })),
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

// ── revise_task (M6.4) — parent-only authz ───────────────────────────────

function reviseTaskTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "revise_task",
    description:
      "Revise a subordinate's blocked task — the canonical post-blocker " +
      "unblock path. Authz: caller must be the assignee's direct parent; " +
      "the subordinate must currently be blocked. Transitions task " +
      "blocked → needs_revision and stamps next_dispatch_context with " +
      "your feedback. Executor picks up within ≤30s; the lower agent's " +
      "session resumes via --resume with your guidance injected as the " +
      "<context type=\"revision\" source=\"parent_agent\" from=\"blocked\"> " +
      "block (M9 skill: post-blocker-revision).",
    schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The subordinate's blocked task to revise." },
        feedback: {
          type: "string",
          description: "Guidance on how to proceed past the blocker.",
        },
      },
      required: ["task_id", "feedback"],
    },
    handler: async (input) => {
      try {
        const taskId = String(input.task_id ?? "");
        const feedback = String(input.feedback ?? "");
        if (!taskId || !feedback) {
          return { content: { error: "task_id and feedback required" }, isError: true };
        }

        const task = await services.taskRepo.findById(taskId);
        if (!task) {
          return { content: { error: "task_not_found", task_id: taskId }, isError: true };
        }
        if (!task.assignee_id) {
          return {
            content: { error: "task_unassigned", message: "task has no assignee" },
            isError: true,
          };
        }

        // Authz: caller must be the assignee's direct parent.
        const assignee = await services.agentRepo.findById(task.assignee_id);
        if (!assignee) {
          return { content: { error: "assignee_not_found" }, isError: true };
        }
        if (assignee.parent_agent_id !== ctx.agentId) {
          return {
            content: {
              error: "not_parent",
              message: `caller ${ctx.agentId} is not the parent of task assignee ${task.assignee_id}`,
            },
            isError: true,
          };
        }

        const updated = await services.taskService.reviseTask(taskId, feedback, {
          source: "parent_agent",
          reviserAgentId: ctx.agentId,
        });
        return {
          content: {
            revised: true,
            task_id: updated.id,
            status: updated.status,
            from_status: task.status,
          },
        };
      } catch (err) {
        if (err instanceof InvalidTaskTransitionError) {
          return { content: { error: "invalid_transition", message: err.message }, isError: true };
        }
        return asError(err);
      }
    },
  };
}

// ── add_to_escalation (M6.4) — populate the OTHER party's slot ──────────

function addToEscalationTool(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool {
  return {
    name: "add_to_escalation",
    description:
      "Contribute your perspective to a peer-initiated escalation. After " +
      "your blocked respond_negotiate returns the 'escalated' sentinel, " +
      "call this with YOUR proposals + open questions for the human " +
      "reviewer. NO summary arg — the initiator already set it (immutable). " +
      "Your slot is determined by your role on the negotiation; you can't " +
      "submit twice. Exit your session after this call.",
    schema: {
      type: "object",
      properties: {
        escalation_id: {
          type: "string",
          description: "The escalation id (from the 'escalated' sentinel).",
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
          description: "Your proposals for the human (different from initiator's).",
        },
        open_questions: {
          type: "array",
          items: { type: "string" },
          description: "Questions in your domain that humans should know about.",
        },
      },
      required: ["escalation_id"],
    },
    handler: async (input) => {
      try {
        const escalationId = String(input.escalation_id ?? "");
        if (!escalationId) {
          return { content: { error: "escalation_id required" }, isError: true };
        }
        const proposals = Array.isArray(input.proposals)
          ? (input.proposals as Array<{ title: string; description: string; tradeoffs?: string }>)
          : undefined;
        const openQuestions = Array.isArray(input.open_questions)
          ? (input.open_questions as string[]).filter((q) => typeof q === "string")
          : undefined;

        const updated = await services.escalationService.addContribution({
          escalationId,
          callerAgentId: ctx.agentId,
          proposals,
          openQuestions,
        });

        // Refresh notification for any future M8 web UI listening.
        await services.pool.query(`SELECT pg_notify('escalation_updated', $1)`, [
          escalationId,
        ]);

        const bothSubmitted =
          updated.initiator_submitted_at !== undefined &&
          updated.counterparty_submitted_at !== undefined;
        return {
          content: {
            escalation_id: updated.id,
            status: updated.status,
            both_sides_submitted: bothSubmitted,
          },
        };
      } catch (err) {
        return asError(err);
      }
    },
  };
}

// ── Assemble per tier ────────────────────────────────────────────────────

/**
 * Tools available to all callers (IC + team + org). 8 total.
 */
function buildSharedTools(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool[] {
  return [
    searchContextTool(ctx, services),
    updateProgressTool(ctx, services),
    findUpTool(ctx, services),
    getAgentProfileTool(ctx, services),
    getTaskTool(ctx, services),
    createWorkProductTool(ctx, services),
    listWorkProductsTool(ctx, services),
    updateWorkProductTool(ctx, services),
  ];
}

/**
 * Team / org tier additions — tools that need subordinates or that
 * participate in mesh-state lifecycle (revise_task, add_to_escalation).
 * 6 additional tools (M6.4).
 */
function buildTeamOnlyTools(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool[] {
  return [
    findSubordinatesTool(ctx, services),
    findPeersTool(ctx, services),
    createTaskTool(ctx, services),
    checkWorkStatusTool(ctx, services),
    reviseTaskTool(ctx, services),
    addToEscalationTool(ctx, services),
  ];
}

/**
 * Build the full hierarchy/work-product/state-mgmt tool set for a caller.
 * Picks IC vs team set based on `ctx.hierarchyLevel`. Team and org both
 * get the team set (org-tier agents have subordinates too).
 *
 * M6.4 totals:
 *   IC tier:   8 shared tools.
 *   Team/org: 14 tools (8 shared + 6 team-only — find_subordinates,
 *                       find_peers, create_task, check_work_status,
 *                       revise_task [parent unblock subordinate],
 *                       add_to_escalation [populate peer slot]).
 */
export function buildHierarchyTools(
  ctx: HierarchyToolContext,
  services: HierarchyToolServices,
): AgentTool[] {
  const shared = buildSharedTools(ctx, services);
  if (ctx.hierarchyLevel === "ic") {
    return shared;
  }
  return [...shared, ...buildTeamOnlyTools(ctx, services)];
}

