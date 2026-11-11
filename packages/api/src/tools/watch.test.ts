/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService, so the service is a
 * fake here and what's under test is the adapter's own work: input
 * coercion (task_ids filtering, mode defaulting, reason trimming), the
 * session-context precondition, and the mapping from the service's
 * typed error classes onto stable MCP error codes.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

type WatchTasksArgs = Parameters<WatchService["watchTasks"]>[0];
type UnwatchArgs = Parameters<WatchService["unwatch"]>[0];

function fakeWatchService(overrides?: {
  watchTasks?: WatchService["watchTasks"];
  unwatch?: WatchService["unwatch"];
}) {
  const watchCalls: WatchTasksArgs[] = [];
  const unwatchCalls: UnwatchArgs[] = [];
  const watchService = {
    watchTasks:
      overrides?.watchTasks ??
      vi.fn(async (input: WatchTasksArgs) => {
        watchCalls.push(input);
        return { watchId: "twch_1", firedImmediately: false };
      }),
    unwatch:
      overrides?.unwatch ??
      vi.fn(async (input: UnwatchArgs) => {
        unwatchCalls.push(input);
      }),
  } as unknown as WatchService;
  return { watchService, watchCalls, unwatchCalls };
}

const ctx: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function tools(
  watchService: WatchService,
  c: WatchToolContext = ctx,
): { watchTasks: AgentTool; unwatch: AgentTool } {
  const built = buildWatchTools(c, { watchService });
  const watchTasks = built.find((t) => t.name === "watch_tasks");
  const unwatch = built.find((t) => t.name === "unwatch");
  if (!watchTasks || !unwatch) throw new Error("tool not built");
  return { watchTasks, unwatch };
}

describe("buildWatchTools", () => {
  it("builds exactly watch_tasks + unwatch, in that order", () => {
    const { watchService } = fakeWatchService();
    const built = buildWatchTools(ctx, { watchService });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises task_ids as the only required watch_tasks arg", () => {
    const { watchService } = fakeWatchService();
    const { watchTasks } = tools(watchService);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    const props = watchTasks.schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["mode", "reason", "task_ids"]);
  });

  it("advertises both watch modes in the mode enum", () => {
    const { watchService } = fakeWatchService();
    const { watchTasks } = tools(watchService);
    const props = watchTasks.schema.properties as Record<
      string,
      { enum?: unknown }
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
  });
});

describe("watch_tasks handler", () => {
  it("forwards caller identity from context and defaults mode to 'all'", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const { watchTasks } = tools(watchService);

    const result = await watchTasks.handler({ task_ids: ["task_1", "task_2"] });

    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0]).toEqual({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      watch_id: "twch_1",
      fired_immediately: false,
    });
  });

  it("passes a valid mode through", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const { watchTasks } = tools(watchService);

    await watchTasks.handler({ task_ids: ["task_1"], mode: "any" });

    expect(watchCalls[0]?.mode).toBe("any");
  });

  it("falls back to 'all' when mode is not a known mode", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const { watchTasks } = tools(watchService);

    await watchTasks.handler({ task_ids: ["task_1"], mode: "whenever" });
    await watchTasks.handler({ task_ids: ["task_1"], mode: 7 });

    expect(watchCalls.map((c) => c.mode)).toEqual(["all", "all"]);
  });

  it("trims reason and drops it when blank", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const { watchTasks } = tools(watchService);

    await watchTasks.handler({ task_ids: ["t"], reason: "  need the diff  " });
    await watchTasks.handler({ task_ids: ["t"], reason: "   " });
    await watchTasks.handler({ task_ids: ["t"], reason: 42 });

    expect(watchCalls.map((c) => c.reason)).toEqual([
      "need the diff",
      undefined,
      undefined,
    ]);
  });

  it("keeps only the string entries of task_ids", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const { watchTasks } = tools(watchService);

    await watchTasks.handler({ task_ids: ["task_1", 2, null, "task_3", {}] });

    expect(watchCalls[0]?.taskIds).toEqual(["task_1", "task_3"]);
  });

  it("reports the fired_immediately race back to the agent", async () => {
    const { watchService } = fakeWatchService({
      watchTasks: vi.fn(async () => ({
        watchId: "twch_raced",
        firedImmediately: true,
      })) as unknown as WatchService["watchTasks"],
    });
    const { watchTasks } = tools(watchService);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "twch_raced",
      fired_immediately: true,
    });
  });

  describe("input rejection (service never called)", () => {
    it.each([
      ["missing task_ids", {}],
      ["empty task_ids", { task_ids: [] }],
      ["task_ids not an array", { task_ids: "task_1" }],
      ["task_ids with no strings", { task_ids: [1, null] }],
    ])("rejects %s as watch_validation", async (_label, input) => {
      const { watchService, watchCalls } = fakeWatchService();
      const { watchTasks } = tools(watchService);

      const result = await watchTasks.handler(input);

      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("watch_validation");
      expect(result.content.message).toBe(
        "task_ids must be a non-empty array of strings",
      );
      expect(watchCalls).toHaveLength(0);
    });
  });

  it("refuses to register a watch with no session context", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const { watchTasks } = tools(watchService, { agentId: "agent_a" });

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchCalls).toHaveLength(0);
  });

  it("validates task_ids before the session-context precondition", async () => {
    // Ordering matters for the agent's debugging: an empty task_ids in a
    // session-less call should still name the task_ids problem.
    const { watchService } = fakeWatchService();
    const { watchTasks } = tools(watchService, { agentId: "agent_a" });

    const result = await watchTasks.handler({ task_ids: [] });

    expect(result.content.message).toBe(
      "task_ids must be a non-empty array of strings",
    );
  });
});

describe("unwatch handler", () => {
  it("forwards the caller agent and watch id", async () => {
    const { watchService, unwatchCalls } = fakeWatchService();
    const { unwatch } = tools(watchService);

    const result = await unwatch.handler({ watch_id: "twch_1" });

    expect(unwatchCalls).toEqual([
      { callerAgentId: "agent_a", watchId: "twch_1" },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({ ok: true });
  });

  it("requires watch_id to be a non-empty string", async () => {
    const { watchService, unwatchCalls } = fakeWatchService();
    const { unwatch } = tools(watchService);

    for (const input of [{}, { watch_id: "" }, { watch_id: 9 }]) {
      const result = await unwatch.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
    }
    expect(unwatchCalls).toHaveLength(0);
  });

  it("stays ok for an already-fired watch — unwatch is idempotent", async () => {
    const { watchService } = fakeWatchService({
      unwatch: vi.fn(async () => {}) as unknown as WatchService["unwatch"],
    });
    const { unwatch } = tools(watchService);

    const first = await unwatch.handler({ watch_id: "twch_1" });
    const second = await unwatch.handler({ watch_id: "twch_1" });

    expect(first.content).toEqual({ ok: true });
    expect(second.content).toEqual({ ok: true });
  });
});

describe("service error mapping", () => {
  // Each WatchService error class has to land on its own stable code —
  // agents branch on `error`, so collapsing them would be a wire break.
  const cases: Array<[Error, string, string]> = [
    [
      new WatchAuthError("task task_9 is not in your conversation chain"),
      "watch_auth",
      "task task_9 is not in your conversation chain",
    ],
    [
      new WatchValidationError("mode must be all or any"),
      "watch_validation",
      "mode must be all or any",
    ],
    [new WatchNotFoundError("twch_gone"), "watch_not_found", "task_watch twch_gone not found"],
    [new Error("pool exhausted"), "watch_error", "pool exhausted"],
  ];

  it.each(cases)(
    "maps %o thrown from watchTasks to its code",
    async (thrown, code, message) => {
      const { watchService } = fakeWatchService({
        watchTasks: vi.fn(async () => {
          throw thrown;
        }) as unknown as WatchService["watchTasks"],
      });
      const { watchTasks } = tools(watchService);

      const result = await watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message });
    },
  );

  it.each(cases)(
    "maps %o thrown from unwatch to its code",
    async (thrown, code, message) => {
      const { watchService } = fakeWatchService({
        unwatch: vi.fn(async () => {
          throw thrown;
        }) as unknown as WatchService["unwatch"],
      });
      const { unwatch } = tools(watchService);

      const result = await unwatch.handler({ watch_id: "twch_1" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message });
    },
  );

  it("stringifies a non-Error throw rather than leaking undefined", async () => {
    const { watchService } = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw "pg down";
      }) as unknown as WatchService["watchTasks"],
    });
    const { watchTasks } = tools(watchService);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({ error: "watch_error", message: "pg down" });
  });
});
