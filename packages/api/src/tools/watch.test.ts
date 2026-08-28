/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService, so what's tested here is
 * exactly the adapter's own share of the contract: argument coercion before
 * the service call, the two guards that short-circuit without touching the
 * service (empty task_ids, absent session context), the mode default, and
 * the mapping from each WatchService error class to its stable error code.
 * The service's own behavior (the insert, the already-terminal race fire,
 * the unwatch state machine) is covered by its DB-backed suite.
 */
import { describe, expect, it, vi } from "vitest";
import { TASK_WATCH_MODES } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

function harness(opts: { watchThrows?: unknown; unwatchThrows?: unknown } = {}) {
  const watchCalls: Array<Record<string, unknown>> = [];
  const unwatchCalls: Array<Record<string, unknown>> = [];
  const watchService = {
    watchTasks: vi.fn(async (input: Record<string, unknown>) => {
      if (opts.watchThrows) throw opts.watchThrows;
      watchCalls.push(input);
      return { watchId: "twch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: Record<string, unknown>) => {
      if (opts.unwatchThrows) throw opts.unwatchThrows;
      unwatchCalls.push(input);
    }),
  } as unknown as WatchService;
  return { watchService, watchCalls, unwatchCalls };
}

function tools(ctx: WatchToolContext, watchService: WatchService) {
  const [watchTasks, unwatch] = buildWatchTools(ctx, { watchService });
  if (!watchTasks || !unwatch) throw new Error("expected two watch tools");
  return { watchTasks, unwatch };
}

const ctx: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watchService } = harness();
    const built = buildWatchTools(ctx, { watchService });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the domain's mode enum rather than a hand-copied list", () => {
    const { watchService } = harness();
    const { watchTasks } = tools(ctx, watchService);
    const props = watchTasks.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode?.enum).toEqual([...TASK_WATCH_MODES]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, ids, mode and trimmed reason to the service", async () => {
    const { watchService, watchCalls } = harness();
    const { watchTasks } = tools(ctx, watchService);

    const result = await watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  waiting on the migration  ",
    });

    expect(watchCalls).toEqual([
      {
        callerAgentId: "agent_a",
        callerSessionId: "sess_1",
        taskIds: ["task_1", "task_2"],
        mode: "any",
        reason: "waiting on the migration",
      },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "twch_1",
      fired_immediately: false,
    });
  });

  it("reports fired_immediately from the service verbatim", async () => {
    const watchService = {
      watchTasks: vi.fn(async () => ({
        watchId: "twch_9",
        firedImmediately: true,
      })),
    } as unknown as WatchService;
    const { watchTasks } = tools(ctx, watchService);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "twch_9",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when absent or not a known mode", async () => {
    const { watchService, watchCalls } = harness();
    const { watchTasks } = tools(ctx, watchService);

    await watchTasks.handler({ task_ids: ["task_1"] });
    await watchTasks.handler({ task_ids: ["task_1"], mode: "sometimes" });
    await watchTasks.handler({ task_ids: ["task_1"], mode: 3 });

    expect(watchCalls.map((c) => c.mode)).toEqual(["all", "all", "all"]);
  });

  it("drops a blank or non-string reason rather than passing it on", async () => {
    const { watchService, watchCalls } = harness();
    const { watchTasks } = tools(ctx, watchService);

    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    await watchTasks.handler({ task_ids: ["task_1"], reason: 5 });

    expect(watchCalls.map((c) => c.reason)).toEqual([undefined, undefined]);
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watchService, watchCalls } = harness();
    const { watchTasks } = tools(ctx, watchService);

    await watchTasks.handler({ task_ids: ["task_1", 2, null, "task_3"] });

    expect(watchCalls[0]?.taskIds).toEqual(["task_1", "task_3"]);
  });

  it.each([
    ["an empty array", []],
    ["an all-non-string array", [1, 2]],
    ["a non-array", "task_1"],
    ["undefined", undefined],
  ])("rejects %s as task_ids without calling the service", async (_label, task_ids) => {
    const { watchService, watchCalls } = harness();
    const { watchTasks } = tools(ctx, watchService);

    const result = await watchTasks.handler({ task_ids });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchCalls).toEqual([]);
  });

  it("refuses to register a watch outside a session context", async () => {
    const { watchService, watchCalls } = harness();
    const { watchTasks } = tools({ agentId: "agent_a" }, watchService);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchCalls).toEqual([]);
  });
});

describe("unwatch", () => {
  it("forwards the caller agent and watch id", async () => {
    const { watchService, unwatchCalls } = harness();
    const { unwatch } = tools(ctx, watchService);

    const result = await unwatch.handler({ watch_id: "twch_1" });

    expect(unwatchCalls).toEqual([
      { callerAgentId: "agent_a", watchId: "twch_1" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 12],
    ["undefined", undefined],
  ])("rejects %s as watch_id without calling the service", async (_label, watch_id) => {
    const { watchService, unwatchCalls } = harness();
    const { unwatch } = tools(ctx, watchService);

    const result = await unwatch.handler({ watch_id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(unwatchCalls).toEqual([]);
  });
});

describe("service error mapping", () => {
  // The codes are the agent-facing contract — an agent branches on
  // `error` to decide whether to retry, re-scope, or give up.
  it.each([
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("too many tasks"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("twch_x"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
  ])("maps %s to %s", async (_label, thrown, code) => {
    const { watchService } = harness({
      watchThrows: thrown,
      unwatchThrows: thrown,
    });
    const { watchTasks, unwatch } = tools(ctx, watchService);

    const watchResult = await watchTasks.handler({ task_ids: ["task_1"] });
    const unwatchResult = await unwatch.handler({ watch_id: "twch_1" });

    for (const result of [watchResult, unwatchResult]) {
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: code,
        message: (thrown as Error).message,
      });
    }
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    const { watchService } = harness({
      watchThrows: "kaboom",
      unwatchThrows: "kaboom",
    });
    const { watchTasks, unwatch } = tools(ctx, watchService);

    for (const result of [
      await watchTasks.handler({ task_ids: ["task_1"] }),
      await unwatch.handler({ watch_id: "twch_1" }),
    ]) {
      expect(result.content).toMatchObject({
        error: "watch_error",
        message: "kaboom",
      });
    }
  });
});
