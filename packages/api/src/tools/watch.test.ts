/**
 * watch_tasks + unwatch MCP tools.
 *
 * Both are thin adapters over WatchService: the service owns the auth
 * check, the insert, the already-terminal race and the unwatch state
 * machine. What lives *here* — and so is what these tests pin — is the
 * input coercion (task_ids filtering, mode defaulting, reason
 * trimming), the session-context guard, and the mapping of the
 * service's typed errors onto stable agent-facing error codes.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
  type UnwatchInput,
} from "@beevibe/core/services/watch-service";

import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Harness {
  services: { watchService: WatchService };
  watchCalls: WatchTasksInput[];
  unwatchCalls: UnwatchInput[];
}

function harness(
  overrides: {
    watchTasks?: (input: WatchTasksInput) => Promise<unknown>;
    unwatch?: (input: UnwatchInput) => Promise<unknown>;
  } = {},
): Harness {
  const watchCalls: WatchTasksInput[] = [];
  const unwatchCalls: UnwatchInput[] = [];
  const watchService = {
    watchTasks: vi.fn(async (input: WatchTasksInput) => {
      watchCalls.push(input);
      if (overrides.watchTasks) return overrides.watchTasks(input);
      return { watchId: "watch_abc", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: UnwatchInput) => {
      unwatchCalls.push(input);
      if (overrides.unwatch) return overrides.unwatch(input);
      return undefined;
    }),
  } as unknown as WatchService;
  return { services: { watchService }, watchCalls, unwatchCalls };
}

const ctx: WatchToolContext = { agentId: "agent_team", sessionId: "sess_1" };

function tools(h: Harness, c: WatchToolContext = ctx) {
  const built = buildWatchTools(c, h.services);
  const watchTasks = built.find((t) => t.name === "watch_tasks");
  const unwatch = built.find((t) => t.name === "unwatch");
  if (!watchTasks || !unwatch) expect.unreachable("both watch tools must be built");
  return { watchTasks: watchTasks!, unwatch: unwatch! };
}

describe("buildWatchTools", () => {
  it("builds exactly watch_tasks and unwatch, in that order", () => {
    const built = buildWatchTools(ctx, harness().services);
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the mode enum from the domain constant", () => {
    const { watchTasks } = tools(harness());
    const props = watchTasks.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks handler", () => {
  it("forwards caller identity, task_ids, mode and reason to the service", async () => {
    const h = harness();
    const { watchTasks } = tools(h);

    const result = await watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "need both results",
    });

    expect(h.watchCalls).toEqual([
      {
        callerAgentId: "agent_team",
        callerSessionId: "sess_1",
        taskIds: ["task_1", "task_2"],
        mode: "any",
        reason: "need both results",
      },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "watch_abc", fired_immediately: false });
  });

  it("surfaces fired_immediately from the service verbatim", async () => {
    const h = harness({
      watchTasks: async () => ({ watchId: "watch_now", firedImmediately: true }),
    });
    const { watchTasks } = tools(h);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({ watch_id: "watch_now", fired_immediately: true });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const h = harness();
    const { watchTasks } = tools(h);

    await watchTasks.handler({ task_ids: ["task_1"] });

    expect(h.watchCalls[0]?.mode).toBe("all");
  });

  it("defaults mode to 'all' when it is not a known mode", async () => {
    const h = harness();
    const { watchTasks } = tools(h);

    await watchTasks.handler({ task_ids: ["task_1"], mode: "eventually" });

    expect(h.watchCalls[0]?.mode).toBe("all");
  });

  it("drops non-string entries from task_ids", async () => {
    const h = harness();
    const { watchTasks } = tools(h);

    await watchTasks.handler({ task_ids: ["task_1", 42, null, "task_2", { id: "x" }] });

    expect(h.watchCalls[0]?.taskIds).toEqual(["task_1", "task_2"]);
  });

  it("trims reason and omits it when blank", async () => {
    const h = harness();
    const { watchTasks } = tools(h);

    await watchTasks.handler({ task_ids: ["task_1"], reason: "  resume the rollout  " });
    expect(h.watchCalls[0]?.reason).toBe("resume the rollout");

    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    expect(h.watchCalls[1]?.reason).toBeUndefined();

    await watchTasks.handler({ task_ids: ["task_1"], reason: 7 });
    expect(h.watchCalls[2]?.reason).toBeUndefined();
  });

  describe("rejects before touching the service", () => {
    it("on a missing task_ids", async () => {
      const h = harness();
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({});

      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("watch_validation");
      expect(h.watchCalls).toHaveLength(0);
    });

    it("on an empty task_ids array", async () => {
      const h = harness();
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({ task_ids: [] });

      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("watch_validation");
      expect(h.watchCalls).toHaveLength(0);
    });

    it("on a task_ids array whose entries are all non-strings", async () => {
      const h = harness();
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({ task_ids: [1, 2, 3] });

      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("watch_validation");
      expect(h.watchCalls).toHaveLength(0);
    });

    it("on a non-array task_ids", async () => {
      const h = harness();
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({ task_ids: "task_1" });

      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("watch_validation");
      expect(h.watchCalls).toHaveLength(0);
    });

    // Without a session id there is no waiter to chain the wake session
    // off, so the handler must refuse rather than insert a dangling row.
    it("when the call has no session context", async () => {
      const h = harness();
      const { watchTasks } = tools(h, { agentId: "agent_team" });

      const result = await watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(String(result.content.message)).toContain("session context");
      expect(h.watchCalls).toHaveLength(0);
    });

    // Validation order matters: a caller with neither a session nor
    // task_ids should hear about task_ids first, matching the handler's
    // top-down checks.
    it("reporting task_ids before the missing session context", async () => {
      const h = harness();
      const { watchTasks } = tools(h, { agentId: "agent_team" });

      const result = await watchTasks.handler({ task_ids: [] });

      expect(String(result.content.message)).toContain("task_ids");
    });
  });

  describe("maps service errors to stable codes", () => {
    it("WatchAuthError -> watch_auth", async () => {
      const h = harness({
        watchTasks: async () => {
          throw new WatchAuthError("task task_1 is not in your chain");
        },
      });
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "watch_auth",
        message: "task task_1 is not in your chain",
      });
    });

    it("WatchValidationError -> watch_validation", async () => {
      const h = harness({
        watchTasks: async () => {
          throw new WatchValidationError("too many task ids");
        },
      });
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.content).toEqual({
        error: "watch_validation",
        message: "too many task ids",
      });
    });

    it("an unexpected Error -> watch_error with its message", async () => {
      const h = harness({
        watchTasks: async () => {
          throw new Error("connection terminated unexpectedly");
        },
      });
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.content).toEqual({
        error: "watch_error",
        message: "connection terminated unexpectedly",
      });
    });

    it("a thrown non-Error -> watch_error with the stringified value", async () => {
      const h = harness({
        watchTasks: async () => {
          throw "pool drained";
        },
      });
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.content).toEqual({ error: "watch_error", message: "pool drained" });
    });
  });
});

describe("unwatch handler", () => {
  it("forwards the caller agent and watch id, and reports ok", async () => {
    const h = harness();
    const { unwatch } = tools(h);

    const result = await unwatch.handler({ watch_id: "watch_abc" });

    expect(h.unwatchCalls).toEqual([
      { callerAgentId: "agent_team", watchId: "watch_abc" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  // Documented as idempotent: a second cancel of the same watch is a
  // success, not an error, so the agent can retry safely.
  it("reports ok on a repeat cancel", async () => {
    const h = harness();
    const { unwatch } = tools(h);

    await unwatch.handler({ watch_id: "watch_abc" });
    const second = await unwatch.handler({ watch_id: "watch_abc" });

    expect(second.content).toEqual({ ok: true });
    expect(h.unwatchCalls).toHaveLength(2);
  });

  it("does not require a session context", async () => {
    const h = harness();
    const { unwatch } = tools(h, { agentId: "agent_team" });

    const result = await unwatch.handler({ watch_id: "watch_abc" });

    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["omitted", {}],
    ["empty", { watch_id: "" }],
    ["a non-string", { watch_id: 12 }],
  ])("rejects a watch_id that is %s", async (_label, input) => {
    const h = harness();
    const { unwatch } = tools(h);

    const result = await unwatch.handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content.error).toBe("watch_validation");
    expect(h.unwatchCalls).toHaveLength(0);
  });

  it("maps WatchNotFoundError -> watch_not_found", async () => {
    const h = harness({
      unwatch: async () => {
        throw new WatchNotFoundError("watch_gone");
      },
    });
    const { unwatch } = tools(h);

    const result = await unwatch.handler({ watch_id: "watch_gone" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "watch_not_found",
      message: "task_watch watch_gone not found",
    });
  });

  it("maps WatchAuthError -> watch_auth", async () => {
    const h = harness({
      unwatch: async () => {
        throw new WatchAuthError("not your watch");
      },
    });
    const { unwatch } = tools(h);

    const result = await unwatch.handler({ watch_id: "watch_other" });

    expect(result.content).toEqual({ error: "watch_auth", message: "not your watch" });
  });
});
