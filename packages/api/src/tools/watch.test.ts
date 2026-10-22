/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService, so what's worth
 * pinning here is exactly the part that isn't the service: the input
 * coercion (which ids survive, what `mode` defaults to, when a blank
 * reason becomes undefined), the session-context guard, and the mapping
 * from each WatchService error class onto its wire code.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

function fakeWatchService(
  overrides: { watchThrows?: unknown; unwatchThrows?: unknown } = {},
) {
  const watchCalls: WatchTasksInput[] = [];
  const unwatchCalls: Array<{ callerAgentId: string; watchId: string }> = [];
  const watchService = {
    watchTasks: vi.fn(async (input: WatchTasksInput) => {
      if (overrides.watchThrows) throw overrides.watchThrows;
      watchCalls.push(input);
      return { watchId: "twh_1", firedImmediately: false };
    }),
    unwatch: vi.fn(
      async (input: { callerAgentId: string; watchId: string }) => {
        if (overrides.unwatchThrows) throw overrides.unwatchThrows;
        unwatchCalls.push(input);
      },
    ),
  } as unknown as WatchService;
  return { watchService, watchCalls, unwatchCalls };
}

const CTX: WatchToolContext = { agentId: "agent_lead", sessionId: "ses_now" };

function tools(watchService: WatchService, ctx: WatchToolContext = CTX) {
  const [watchTasks, unwatch] = buildWatchTools(ctx, { watchService });
  return { watchTasks: watchTasks!, unwatch: unwatch! };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks then unwatch", () => {
    const { watchService } = fakeWatchService();
    const built = buildWatchTools(CTX, { watchService });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares task_ids as the only required watch_tasks arg", () => {
    const { watchService } = fakeWatchService();
    const schema = tools(watchService).watchTasks.schema as {
      required: string[];
      properties: { mode: { enum: string[] } };
    };
    expect(schema.required).toEqual(["task_ids"]);
    // The enum is the domain's mode list, so the agent can't invent one.
    expect(schema.properties.mode.enum.sort()).toEqual(["all", "any"]);
  });
});

describe("watch_tasks input handling", () => {
  it("forwards caller identity, ids, mode and reason to the service", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const result = await tools(watchService).watchTasks.handler({
      task_ids: ["tsk_a", "tsk_b"],
      mode: "any",
      reason: "  need the migration result  ",
    });

    expect(watchCalls).toEqual([
      {
        callerAgentId: "agent_lead",
        callerSessionId: "ses_now",
        taskIds: ["tsk_a", "tsk_b"],
        mode: "any",
        reason: "need the migration result",
      },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "twh_1",
      fired_immediately: false,
    });
  });

  it("defaults mode to 'all' when absent or not a known mode", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const t = tools(watchService).watchTasks;
    await t.handler({ task_ids: ["tsk_a"] });
    await t.handler({ task_ids: ["tsk_a"], mode: "either" });
    await t.handler({ task_ids: ["tsk_a"], mode: 7 });

    expect(watchCalls.map((c) => c.mode)).toEqual(["all", "all", "all"]);
  });

  it("drops a blank or non-string reason rather than passing it through", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    const t = tools(watchService).watchTasks;
    await t.handler({ task_ids: ["tsk_a"], reason: "   " });
    await t.handler({ task_ids: ["tsk_a"], reason: 1 });
    await t.handler({ task_ids: ["tsk_a"] });

    expect(watchCalls.map((c) => c.reason)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("filters non-string ids out of the array", async () => {
    const { watchService, watchCalls } = fakeWatchService();
    await tools(watchService).watchTasks.handler({
      task_ids: ["tsk_a", 42, null, "tsk_b", { id: "tsk_c" }],
    });
    expect(watchCalls[0]?.taskIds).toEqual(["tsk_a", "tsk_b"]);
  });

  it("reports the firedImmediately race result verbatim", async () => {
    const { watchService } = fakeWatchService();
    vi.mocked(watchService.watchTasks).mockResolvedValue({
      watchId: "twh_raced",
      firedImmediately: true,
    });
    const result = await tools(watchService).watchTasks.handler({
      task_ids: ["tsk_done"],
    });
    expect(result.content).toEqual({
      watch_id: "twh_raced",
      fired_immediately: true,
    });
  });
});

describe("watch_tasks guards", () => {
  it.each([
    ["an empty array", []],
    ["an array of only non-strings", [1, null]],
    ["a non-array", "tsk_a"],
    ["omitted", undefined],
  ])("rejects task_ids given as %s", async (_label, taskIds) => {
    const { watchService } = fakeWatchService();
    const result = await tools(watchService).watchTasks.handler(
      taskIds === undefined ? {} : { task_ids: taskIds },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  // Without a session id the service can't identify the waiter, so the
  // handler refuses rather than registering an unwakeable watch.
  it("rejects a call made outside a session context", async () => {
    const { watchService } = fakeWatchService();
    const result = await tools(watchService, {
      agentId: "agent_lead",
    }).watchTasks.handler({ task_ids: ["tsk_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  // The ids guard runs first, so a caller missing both gets the ids
  // error — pinned so the message doesn't silently swap.
  it("reports the task_ids problem first when both are wrong", async () => {
    const { watchService } = fakeWatchService();
    const result = await tools(watchService, {
      agentId: "agent_lead",
    }).watchTasks.handler({});
    expect(result.content).toMatchObject({
      message: "task_ids must be a non-empty array of strings",
    });
  });
});

describe("unwatch", () => {
  it("forwards the watch id with the caller's agent id", async () => {
    const { watchService, unwatchCalls } = fakeWatchService();
    const result = await tools(watchService).unwatch.handler({
      watch_id: "twh_1",
    });

    expect(unwatchCalls).toEqual([
      { callerAgentId: "agent_lead", watchId: "twh_1" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("does not require a session context", async () => {
    const { watchService, unwatchCalls } = fakeWatchService();
    const result = await tools(watchService, {
      agentId: "agent_lead",
    }).unwatch.handler({ watch_id: "twh_1" });

    expect(result.content).toEqual({ ok: true });
    expect(unwatchCalls).toHaveLength(1);
  });

  it.each([
    ["omitted", undefined],
    ["blank", ""],
    ["a non-string", 7],
  ])("rejects a %s watch_id", async (_label, watchId) => {
    const { watchService } = fakeWatchService();
    const result = await tools(watchService).unwatch.handler(
      watchId === undefined ? {} : { watch_id: watchId },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });

  it("declares watch_id required", () => {
    const { watchService } = fakeWatchService();
    const schema = tools(watchService).unwatch.schema as { required: string[] };
    expect(schema.required).toEqual(["watch_id"]);
  });
});

describe("WatchService error mapping", () => {
  // Shared by both handlers via caughtError, so each case is asserted
  // on watch_tasks and unwatch alike.
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("duplicate ids"),
      "watch_validation",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("no such watch"),
      "watch_not_found",
    ],
    ["a plain Error", new Error("pool closed"), "watch_error"],
    ["a thrown string", "pg died", "watch_error"],
  ];

  it.each(cases)("maps %s from watch_tasks", async (_label, thrown, code) => {
    const { watchService } = fakeWatchService({ watchThrows: thrown });
    const result = await tools(watchService).watchTasks.handler({
      task_ids: ["tsk_a"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
    expect(result.content.message).toBe(
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  });

  it.each(cases)("maps %s from unwatch", async (_label, thrown, code) => {
    const { watchService } = fakeWatchService({ unwatchThrows: thrown });
    const result = await tools(watchService).unwatch.handler({
      watch_id: "twh_1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });
});
