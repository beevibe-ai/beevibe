import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

/**
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check and the state machine. What's worth pinning here is the
 * adapter's own logic: input coercion, the mode default, and the mapping
 * from each service error class to a stable tool error code.
 */
function harness(
  ctx: Partial<WatchToolContext> = {},
  behaviour: {
    watchTasks?: () => Promise<unknown>;
    unwatch?: () => Promise<unknown>;
  } = {},
) {
  const watchCalls: Array<Record<string, unknown>> = [];
  const unwatchCalls: Array<Record<string, unknown>> = [];

  const watchService = {
    watchTasks: vi.fn(async (args: Record<string, unknown>) => {
      watchCalls.push(args);
      if (behaviour.watchTasks) return behaviour.watchTasks();
      return { watchId: "watch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (args: Record<string, unknown>) => {
      unwatchCalls.push(args);
      if (behaviour.unwatch) return behaviour.unwatch();
      return undefined;
    }),
  } as unknown as WatchService;

  const [watchTasks, unwatch] = buildWatchTools(
    { agentId: "agent_a", sessionId: "sess_1", ...ctx },
    { watchService },
  );
  return { watchTasks: watchTasks!, unwatch: unwatch!, watchCalls, unwatchCalls };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watchTasks, unwatch } = harness();
    expect(watchTasks.name).toBe("watch_tasks");
    expect(unwatch.name).toBe("unwatch");
  });

  it("exposes the required fields on each schema", () => {
    const { watchTasks, unwatch } = harness();
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });

  it("advertises both fire modes on the watch_tasks schema", () => {
    const { watchTasks } = harness();
    const props = watchTasks.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(expect.arrayContaining(["all", "any"]));
  });
});

describe("watch_tasks", () => {
  it("forwards caller context, task ids, mode and reason to the service", async () => {
    const { watchTasks, watchCalls } = harness();

    const result = await watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(watchCalls[0]).toEqual({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "watch_1",
      fired_immediately: false,
    });
  });

  it("surfaces fired_immediately from the service", async () => {
    const { watchTasks } = harness(
      {},
      {
        watchTasks: async () => ({
          watchId: "watch_9",
          firedImmediately: true,
        }),
      },
    );

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "watch_9",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const { watchTasks, watchCalls } = harness();

    await watchTasks.handler({ task_ids: ["task_1"] });

    expect(watchCalls[0]?.mode).toBe("all");
  });

  it.each([
    ["an unknown string", "eventually"],
    ["a non-string", 1],
    ["null", null],
  ])("falls back to 'all' when mode is %s", async (_label, mode) => {
    const { watchTasks, watchCalls } = harness();

    await watchTasks.handler({ task_ids: ["task_1"], mode });

    expect(watchCalls[0]?.mode).toBe("all");
  });

  it("drops non-string entries from task_ids", async () => {
    const { watchTasks, watchCalls } = harness();

    await watchTasks.handler({ task_ids: ["task_1", 2, null, "task_3"] });

    expect(watchCalls[0]?.taskIds).toEqual(["task_1", "task_3"]);
  });

  it.each([
    ["empty", []],
    ["all non-strings", [1, null]],
    ["not an array", "task_1"],
    ["absent", undefined],
  ])("rejects task_ids that are %s", async (_label, task_ids) => {
    const { watchTasks, watchCalls } = harness();

    const result = await watchTasks.handler({ task_ids });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchCalls).toHaveLength(0);
  });

  it.each([
    ["blank", "   "],
    ["a non-string", 5],
  ])("omits a reason that is %s", async (_label, reason) => {
    const { watchTasks, watchCalls } = harness();

    await watchTasks.handler({ task_ids: ["task_1"], reason });

    expect(watchCalls[0]?.reason).toBeUndefined();
  });

  it("refuses to register a watch without a session context", async () => {
    const { watchTasks, watchCalls } = harness({ sessionId: undefined });

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchCalls).toHaveLength(0);
  });

  it.each([
    ["WatchAuthError", () => new WatchAuthError("not yours"), "watch_auth"],
    [
      "WatchValidationError",
      () => new WatchValidationError("bad ids"),
      "watch_validation",
    ],
    [
      "WatchNotFoundError",
      () => new WatchNotFoundError("gone"),
      "watch_not_found",
    ],
    ["a plain Error", () => new Error("db down"), "watch_error"],
  ])("maps %s to the %s code", async (_label, make, code) => {
    const { watchTasks } = harness(
      {},
      { watchTasks: () => Promise.reject(make()) },
    );

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });

  it("stringifies a non-Error rejection", async () => {
    const { watchTasks } = harness(
      {},
      { watchTasks: () => Promise.reject("nope") },
    );

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "nope",
    });
  });
});

describe("unwatch", () => {
  it("forwards the caller agent and watch id, and reports ok", async () => {
    const { unwatch, unwatchCalls } = harness();

    const result = await unwatch.handler({ watch_id: "watch_1" });

    expect(unwatchCalls[0]).toEqual({
      callerAgentId: "agent_a",
      watchId: "watch_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["empty", ""],
    ["a non-string", 3],
    ["absent", undefined],
  ])("rejects a watch_id that is %s", async (_label, watch_id) => {
    const { unwatch, unwatchCalls } = harness();

    const result = await unwatch.handler({ watch_id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(unwatchCalls).toHaveLength(0);
  });

  it.each([
    ["WatchAuthError", () => new WatchAuthError("not yours"), "watch_auth"],
    [
      "WatchNotFoundError",
      () => new WatchNotFoundError("no such watch"),
      "watch_not_found",
    ],
    ["a plain Error", () => new Error("db down"), "watch_error"],
  ])("maps %s to the %s code", async (_label, make, code) => {
    const { unwatch } = harness({}, { unwatch: () => Promise.reject(make()) });

    const result = await unwatch.handler({ watch_id: "watch_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });

  it("does not require a session context", async () => {
    const { unwatch, unwatchCalls } = harness({ sessionId: undefined });

    const result = await unwatch.handler({ watch_id: "watch_1" });

    expect(result.isError).toBeFalsy();
    expect(unwatchCalls).toHaveLength(1);
  });
});
