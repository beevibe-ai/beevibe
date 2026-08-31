/**
 * watch_tasks + unwatch — team-tier MCP tools that back the
 * task-completion wake-up feature. Both are thin adapters over
 * WatchService; the service does the auth check, the watch insert,
 * the already-terminal-race fire, and the unwatch state machine.
 *
 * The MCP tool descriptions are the agent-facing source of truth for
 * the contract (modes, ordering, what "fires" means). The system-
 * prompt nudge in spawn-prep tells agents to call watch_tasks; the
 * *how* lives here so the agent sees it at the decide-to-call moment.
 */

import { TASK_WATCH_MODES, type TaskWatchMode } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { toolError } from "./errors.js";
import {
  optionalString,
  optionalStringArray,
  optionalTrimmedString,
} from "./input.js";
import type { AgentTool, AgentToolResult } from "./types.js";

export interface WatchToolContext {
  agentId: string;
  /** Beevibe session id (the MCP caller). Without this watch_tasks can't
   *  identify the waiter, so the handler returns an error. */
  sessionId?: string;
}

export interface WatchToolServices {
  watchService: WatchService;
}

function isMode(value: unknown): value is TaskWatchMode {
  return (
    typeof value === "string" &&
    (TASK_WATCH_MODES as readonly string[]).includes(value)
  );
}

function caughtError(err: unknown): AgentToolResult {
  if (err instanceof WatchAuthError) return toolError("watch_auth", err.message);
  if (err instanceof WatchValidationError) {
    return toolError("watch_validation", err.message);
  }
  if (err instanceof WatchNotFoundError) {
    return toolError("watch_not_found", err.message);
  }
  if (err instanceof Error) return toolError("watch_error", err.message);
  return toolError("watch_error", String(err));
}

function buildWatchTasksTool(
  ctx: WatchToolContext,
  services: WatchToolServices,
): AgentTool {
  return {
    name: "watch_tasks",
    description:
      "Register a wake-up for one or more tasks you dispatched. When the " +
      "watch fires, you'll be re-invoked in a new session that resumes " +
      "this conversation with a system message describing what " +
      "completed. Call this before ending your turn when you plan to " +
      "react to dispatched work's result — without it, the tasks run " +
      "but you won't be re-invoked.\n\n" +
      "Modes:\n" +
      "  • \"all\" — fire when EVERY task reaches a terminal status " +
      "(done | failed | cancelled). Use when your next step needs every " +
      "result.\n" +
      "  • \"any\" — fire on the FIRST task to reach a terminal status. " +
      "Use when you want to react as soon as any signal arrives.\n\n" +
      "The watch is one-shot. Returns { watch_id, fired_immediately }. " +
      "If the condition was already met at call time, fired_immediately " +
      "is true and the next session spawns synchronously.",
    schema: {
      type: "object",
      properties: {
        task_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Ids returned by create_task; must belong to your conversation chain.",
        },
        mode: {
          type: "string",
          enum: [...TASK_WATCH_MODES],
          description: "Fire condition; defaults to 'all'.",
        },
        reason: {
          type: "string",
          description:
            "Short note for your future self; appears in the wake intent.",
        },
      },
      required: ["task_ids"],
    },
    handler: async (input) => {
      try {
        const taskIds = optionalStringArray(input, "task_ids") ?? [];
        if (taskIds.length === 0) {
          return toolError(
            "watch_validation",
            "task_ids must be a non-empty array of strings",
          );
        }
        const mode: TaskWatchMode = isMode(input.mode) ? input.mode : "all";
        const reason = optionalTrimmedString(input, "reason");
        if (!ctx.sessionId) {
          return toolError(
            "watch_validation",
            "watch_tasks must be called inside a session context",
          );
        }

        const result = await services.watchService.watchTasks({
          callerAgentId: ctx.agentId,
          callerSessionId: ctx.sessionId,
          taskIds,
          mode,
          reason,
        });
        return {
          content: {
            watch_id: result.watchId,
            fired_immediately: result.firedImmediately,
          },
        };
      } catch (err) {
        return caughtError(err);
      }
    },
  };
}

function buildUnwatchTool(
  ctx: WatchToolContext,
  services: WatchToolServices,
): AgentTool {
  return {
    name: "unwatch",
    description:
      "Cancel a pending task_watch you previously registered. Use when " +
      "you've changed your mind and no longer need the wake-up. " +
      "Idempotent — returns ok whether the watch was waiting, fired, " +
      "or aborted.",
    schema: {
      type: "object",
      properties: {
        watch_id: {
          type: "string",
          description: "Id returned by watch_tasks.",
        },
      },
      required: ["watch_id"],
    },
    handler: async (input) => {
      try {
        const watchId = optionalString(input, "watch_id") ?? "";
        if (!watchId) {
          return toolError(
            "watch_validation",
            "watch_id must be a non-empty string",
          );
        }
        await services.watchService.unwatch({
          callerAgentId: ctx.agentId,
          watchId,
        });
        return { content: { ok: true } };
      } catch (err) {
        return caughtError(err);
      }
    },
  };
}

export function buildWatchTools(
  ctx: WatchToolContext,
  services: WatchToolServices,
): AgentTool[] {
  return [buildWatchTasksTool(ctx, services), buildUnwatchTool(ctx, services)];
}
