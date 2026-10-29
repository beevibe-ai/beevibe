/**
 * watch_tasks + unwatch — unit tests over a faked WatchService (no DB).
 *
 * These two tools are thin adapters, so what's worth pinning is the
 * adapter layer itself: the input coercion that happens before the
 * service is reached (task_ids filtering, mode defaulting, reason
 * trimming, the missing-session guard) and the error mapping that turns
 * each WatchService error class into a stable `error` code the calling
 * agent branches on.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type UnwatchInput,
  type WatchService,
  type WatchTasksInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

function fakeWatchService(
  overrides: Partial<Record<"watchTasks" | "unwatch", WatchService[keyof WatchService]>> = {},
) {
  const watchTasks = vi.fn(async (_input: WatchTasksInput) => ({
    watchId: "wch_1",
    firedImmediately: false,
  }));
  const unwatch = vi.fn(async (_input: UnwatchInput) => undefined);
  const watchService = {
    watchTasks,
    unwatch,
    ...overrides,
  } as unknown as WatchService;
  return { watchService, watchTasks, unwatch };
}

function tools(
  ctx: Partial<WatchToolContext> = {},
  watchService: WatchService = fakeWatchService().watchService,
): { watch: AgentTool; unwatch: AgentTool } {
  const [watch, unwatchTool] = buildWatchTools(
    { agentId: "agent_team", sessionId: "sess_caller", ...ctx },
    { watchService },
  );
  return { watch: watch!, unwatch: unwatchTool! };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const built = buildWatchTools(
      { agentId: "agent_team", sessionId: "sess_caller" },
      { watchService: fakeWatchService().watchService },
    );
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both watch modes in the schema enum", () => {
    const { watch } = tools();
    const schema = watch.schema as {
      properties: { mode: { enum: string[] }; task_ids: { minItems: number } };
      required: string[];
    };
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    expect(schema.properties.task_ids.minItems).toBe(1);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks handler", () => {
  it("passes caller context, task ids, mode and reason through to the service", async () => {
    const { watchService, watchTasks } = fakeWatchService();
    const { watch } = tools({}, watchService);

    const res = await watch.handler({
      task_ids: ["tsk_a", "tsk_b"],
      mode: "any",
      reason: "need the first result",
    });

    expect(watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_team",
      callerSessionId: "sess_caller",
      taskIds: ["tsk_a", "tsk_b"],
      mode: "any",
      reason: "need the first result",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({ watch_id: "wch_1", fired_immediately: false });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const { watchService, watchTasks } = fakeWatchService();
    const { watch } = tools({}, watchService);

    await watch.handler({ task_ids: ["tsk_a"] });
    await watch.handler({ task_ids: ["tsk_a"], mode: "every" });
    await watch.handler({ task_ids: ["tsk_a"], mode: 7 });

    expect(watchTasks.mock.calls.map((c) => c[0].mode)).toEqual([
      "all",
      "all",
      "all",
    ]);
  });

  it("trims reason and drops a blank one", async () => {
    const { watchService, watchTasks } = fakeWatchService();
    const { watch } = tools({}, watchService);

    await watch.handler({ task_ids: ["tsk_a"], reason: "  spaced  " });
    await watch.handler({ task_ids: ["tsk_a"], reason: "   " });
    await watch.handler({ task_ids: ["tsk_a"], reason: 42 });

    const reasons = watchTasks.mock.calls.map((c) => c[0].reason);
    expect(reasons).toEqual(["spaced", undefined, undefined]);
  });

  it("keeps only string task ids and rejects when none survive", async () => {
    const { watchService, watchTasks } = fakeWatchService();
    const { watch } = tools({}, watchService);

    await watch.handler({ task_ids: ["tsk_a", 1, null, "tsk_b"] });
    expect(watchTasks.mock.calls[0]?.[0].taskIds).toEqual([
      "tsk_a",
      "tsk_b",
    ]);

    const res = await watch.handler({ task_ids: [1, null] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-array task_ids without reaching the service", async () => {
    const { watchService, watchTasks } = fakeWatchService();
    const { watch } = tools({}, watchService);

    const res = await watch.handler({ task_ids: "tsk_a" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "watch_validation",
      message: "task_ids must be a non-empty array of strings",
    });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects when the tool is called outside a session context", async () => {
    const { watchService, watchTasks } = fakeWatchService();
    const { watch } = tools({ sessionId: undefined }, watchService);

    const res = await watch.handler({ task_ids: ["tsk_a"] });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const { watchService } = fakeWatchService({
      watchTasks: vi.fn(async () => ({ watchId: "wch_now", firedImmediately: true })) as never,
    });
    const { watch } = tools({}, watchService);

    const res = await watch.handler({ task_ids: ["tsk_done"] });

    expect(res.content).toEqual({ watch_id: "wch_now", fired_immediately: true });
  });
});

describe("unwatch handler", () => {
  it("cancels the watch for the calling agent", async () => {
    const { watchService, unwatch } = fakeWatchService();
    const { unwatch: tool } = tools({}, watchService);

    const res = await tool.handler({ watch_id: "wch_1" });

    expect(unwatch).toHaveBeenCalledWith({ callerAgentId: "agent_team", watchId: "wch_1" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without reaching the service", async () => {
    const { watchService, unwatch } = fakeWatchService();
    const { unwatch: tool } = tools({}, watchService);

    for (const input of [{}, { watch_id: "" }, { watch_id: 5 }]) {
      const res = await tool.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
    }
    expect(unwatch).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  const cases: Array<[string, unknown, string, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth", "not your task"],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
      "task_ids must be non-empty",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("wch_gone"),
      "watch_not_found",
      "task_watch wch_gone not found",
    ],
    ["a plain Error", new Error("pool exhausted"), "watch_error", "pool exhausted"],
    ["a non-Error throw", "boom", "watch_error", "boom"],
  ];

  it.each(cases)("maps %s thrown by watchTasks", async (_label, thrown, code, message) => {
    const { watchService } = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw thrown;
      }) as never,
    });
    const { watch } = tools({}, watchService);

    const res = await watch.handler({ task_ids: ["tsk_a"] });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message });
  });

  it.each(cases)("maps %s thrown by unwatch", async (_label, thrown, code, message) => {
    const { watchService } = fakeWatchService({
      unwatch: vi.fn(async () => {
        throw thrown;
      }) as never,
    });
    const { unwatch: tool } = tools({}, watchService);

    const res = await tool.handler({ watch_id: "wch_1" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message });
  });
});
