import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

interface Harness {
  tools: AgentTool[];
  watchTasks: AgentTool;
  unwatch: AgentTool;
  watchCalls: WatchTasksInput[];
  unwatchCalls: Array<{ callerAgentId: string; watchId: string }>;
}

function harness(
  opts: {
    ctx?: Partial<WatchToolContext>;
    watchResult?: { watchId: string; firedImmediately: boolean };
    watchThrow?: unknown;
    unwatchThrow?: unknown;
  } = {},
): Harness {
  const watchCalls: WatchTasksInput[] = [];
  const unwatchCalls: Array<{ callerAgentId: string; watchId: string }> = [];

  const watchService = {
    watchTasks: vi.fn(async (input: WatchTasksInput) => {
      if (opts.watchThrow !== undefined) throw opts.watchThrow;
      watchCalls.push(input);
      return opts.watchResult ?? { watchId: "watch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: { callerAgentId: string; watchId: string }) => {
      if (opts.unwatchThrow !== undefined) throw opts.unwatchThrow;
      unwatchCalls.push(input);
    }),
  } as unknown as WatchService;

  const tools = buildWatchTools(
    { agentId: "agent_team", sessionId: "sess_caller", ...opts.ctx },
    { watchService },
  );
  const byName = (n: string): AgentTool => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`tool ${n} not built`);
    return t;
  };

  return {
    tools,
    watchTasks: byName("watch_tasks"),
    unwatch: byName("unwatch"),
    watchCalls,
    unwatchCalls,
  };
}

describe("buildWatchTools descriptors", () => {
  it("builds watch_tasks and unwatch, in that order", () => {
    expect(harness().tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both fire modes on the watch_tasks schema", () => {
    const schema = harness().watchTasks.schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };

    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    expect(schema.required).toEqual(["task_ids"]);
  });

  it("requires watch_id on unwatch and documents its idempotence", () => {
    const h = harness();

    expect((h.unwatch.schema as { required: string[] }).required).toEqual([
      "watch_id",
    ]);
    expect(h.unwatch.description).toContain("Idempotent");
  });
});

describe("watch_tasks", () => {
  it("passes the caller agent, caller session and task ids to WatchService", async () => {
    const h = harness();
    const result = await h.watchTasks.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });

    expect(h.watchCalls).toEqual([
      {
        callerAgentId: "agent_team",
        callerSessionId: "sess_caller",
        taskIds: ["task_a", "task_b"],
        mode: "any",
        reason: "need the first result",
      },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "watch_1",
      fired_immediately: false,
    });
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const h = harness({
      watchResult: { watchId: "watch_now", firedImmediately: true },
    });
    const result = await h.watchTasks.handler({ task_ids: ["task_a"] });

    expect(result.content).toEqual({
      watch_id: "watch_now",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all'", async () => {
    const h = harness();
    await h.watchTasks.handler({ task_ids: ["task_a"] });

    expect(h.watchCalls[0]?.mode).toBe("all");
  });

  it.each([["sometimes"], [""], [null], [7]])(
    "falls back to 'all' for the unrecognized mode %p",
    async (mode) => {
      const h = harness();
      await h.watchTasks.handler({ task_ids: ["task_a"], mode });

      expect(h.watchCalls[0]?.mode).toBe("all");
    },
  );

  it("trims a reason and drops a blank or non-string one", async () => {
    const h = harness();
    await h.watchTasks.handler({ task_ids: ["t"], reason: "  look here  " });
    await h.watchTasks.handler({ task_ids: ["t"], reason: "   " });
    await h.watchTasks.handler({ task_ids: ["t"], reason: 12 });

    expect(h.watchCalls.map((c) => c.reason)).toEqual([
      "look here",
      undefined,
      undefined,
    ]);
  });

  it("keeps only the string entries of task_ids", async () => {
    const h = harness();
    await h.watchTasks.handler({ task_ids: ["task_a", 7, null, "task_b", {}] });

    expect(h.watchCalls[0]?.taskIds).toEqual(["task_a", "task_b"]);
  });

  it.each([
    ["an empty array", []],
    ["an array with no strings", [1, null]],
    ["not an array", "task_a"],
    ["absent", undefined],
  ])("rejects task_ids that is %s without calling the service", async (_l, taskIds) => {
    const h = harness();
    const result = await h.watchTasks.handler(
      taskIds === undefined ? {} : { task_ids: taskIds },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "task_ids must be a non-empty array of strings",
    });
    expect(h.watchCalls).toHaveLength(0);
  });

  it("refuses to register a watch outside a session context", async () => {
    const h = harness({ ctx: { sessionId: undefined } });
    const result = await h.watchTasks.handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchCalls).toHaveLength(0);
  });
});

describe("unwatch", () => {
  it("cancels the named watch for the calling agent", async () => {
    const h = harness();
    const result = await h.unwatch.handler({ watch_id: "watch_7" });

    expect(h.unwatchCalls).toEqual([
      { callerAgentId: "agent_team", watchId: "watch_7" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["non-string", 42],
  ])("rejects a %s watch_id without calling the service", async (_l, watchId) => {
    const h = harness();
    const result = await h.unwatch.handler(
      watchId === undefined ? {} : { watch_id: watchId },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(h.unwatchCalls).toHaveLength(0);
  });
});

describe("service error mapping", () => {
  const cases: Array<[string, unknown, string, string]> = [
    [
      "WatchAuthError",
      new WatchAuthError("task task_x is not in your chain"),
      "watch_auth",
      "task task_x is not in your chain",
    ],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
      "task_ids must be non-empty",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("watch_9"),
      "watch_not_found",
      "task_watch watch_9 not found",
    ],
    [
      "a plain Error",
      new Error("connection terminated"),
      "watch_error",
      "connection terminated",
    ],
    ["a thrown string", "pg exploded", "watch_error", "pg exploded"],
  ];

  it.each(cases)(
    "maps %s out of watch_tasks",
    async (_label, thrown, code, message) => {
      const h = harness({ watchThrow: thrown });
      const result = await h.watchTasks.handler({ task_ids: ["task_a"] });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code, message });
    },
  );

  it.each(cases)(
    "maps %s out of unwatch",
    async (_label, thrown, code, message) => {
      const h = harness({ unwatchThrow: thrown });
      const result = await h.unwatch.handler({ watch_id: "watch_7" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code, message });
    },
  );
});
