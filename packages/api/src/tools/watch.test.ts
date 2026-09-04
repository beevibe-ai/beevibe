/**
 * watch_tasks + unwatch — unit tests with vitest fakes (no DB).
 *
 * Both tools are thin adapters over WatchService, so what's worth
 * pinning here is the adapter's own logic: the input coercion
 * (task_ids filtering, mode fallback, reason trimming), the
 * session-context guard, and the error-class → error-code mapping that
 * decides what the calling agent can branch on.
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

const AGENT_ID = "agent_lead";
const SESSION_ID = "sess_now";

interface Harness {
  watchTasks: AgentTool;
  unwatch: AgentTool;
  watchTasksFn: ReturnType<typeof vi.fn>;
  unwatchFn: ReturnType<typeof vi.fn>;
}

function makeTools(
  ctx: Partial<WatchToolContext> = {},
  service: Partial<Record<"watchTasks" | "unwatch", ReturnType<typeof vi.fn>>> = {},
): Harness {
  const watchTasksFn =
    service.watchTasks ??
    vi.fn(async () => ({ watchId: "twt_1", firedImmediately: false }));
  const unwatchFn = service.unwatch ?? vi.fn(async () => undefined);

  const tools = buildWatchTools(
    { agentId: AGENT_ID, sessionId: SESSION_ID, ...ctx },
    {
      watchService: {
        watchTasks: watchTasksFn,
        unwatch: unwatchFn,
      } as unknown as WatchService,
    },
  );

  return {
    watchTasks: tools[0]!,
    unwatch: tools[1]!,
    watchTasksFn,
    unwatchFn,
  };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watchTasks, unwatch } = makeTools();
    expect(watchTasks.name).toBe("watch_tasks");
    expect(unwatch.name).toBe("unwatch");
  });

  it("advertises every task-watch mode on the watch_tasks schema", () => {
    const { watchTasks } = makeTools();
    const props = watchTasks.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode!.enum).toEqual(["all", "any"]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks — input coercion", () => {
  it("forwards the caller, session, ids, mode and reason", async () => {
    const { watchTasks, watchTasksFn } = makeTools();
    const res = await watchTasks.handler({
      task_ids: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "  need the migration result  ",
    });

    expect(watchTasksFn).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
      taskIds: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "need the migration result",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "twt_1", fired_immediately: false });
  });

  it("surfaces an already-terminal race as fired_immediately", async () => {
    const { watchTasks } = makeTools(
      {},
      {
        watchTasks: vi.fn(async () => ({
          watchId: "twt_9",
          firedImmediately: true,
        })),
      },
    );
    const res = await watchTasks.handler({ task_ids: ["tsk_1"] });
    expect(res.content).toEqual({ watch_id: "twt_9", fired_immediately: true });
  });

  it("drops non-string entries from task_ids", async () => {
    const { watchTasks, watchTasksFn } = makeTools();
    await watchTasks.handler({ task_ids: ["tsk_1", 42, null, "tsk_2"] });
    expect(watchTasksFn.mock.calls[0]![0].taskIds).toEqual(["tsk_1", "tsk_2"]);
  });

  it.each([
    ["omitted", undefined],
    ["empty", []],
    ["not an array", "tsk_1"],
    ["all non-strings", [1, 2]],
  ])("rejects task_ids that are %s", async (_label, taskIds) => {
    const { watchTasks, watchTasksFn } = makeTools();
    const res = await watchTasks.handler({ task_ids: taskIds });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchTasksFn).not.toHaveBeenCalled();
  });

  it.each([
    ["omitted", undefined],
    ["not a known mode", "eventually"],
    ["not a string", 1],
  ])("defaults mode to 'all' when it is %s", async (_label, mode) => {
    const { watchTasks, watchTasksFn } = makeTools();
    await watchTasks.handler({ task_ids: ["tsk_1"], mode });
    expect(watchTasksFn.mock.calls[0]![0].mode).toBe("all");
  });

  it.each([
    ["omitted", undefined],
    ["blank", "   "],
    ["not a string", 3],
  ])("drops a reason that is %s", async (_label, reason) => {
    const { watchTasks, watchTasksFn } = makeTools();
    await watchTasks.handler({ task_ids: ["tsk_1"], reason });
    expect(watchTasksFn.mock.calls[0]![0].reason).toBeUndefined();
  });

  it("refuses to register a watch outside a session context", async () => {
    const { watchTasks, watchTasksFn } = makeTools({ sessionId: undefined });
    const res = await watchTasks.handler({ task_ids: ["tsk_1"] });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchTasksFn).not.toHaveBeenCalled();
  });

  it("checks task_ids before the session context", async () => {
    // Both are invalid; the id complaint is the more actionable one.
    const { watchTasks } = makeTools({ sessionId: undefined });
    const res = await watchTasks.handler({ task_ids: [] });
    expect(res.content.message).toContain("task_ids must be a non-empty array");
  });
});

describe("unwatch", () => {
  it("cancels by id and reports ok", async () => {
    const { unwatch, unwatchFn } = makeTools();
    const res = await unwatch.handler({ watch_id: "twt_1" });
    expect(unwatchFn).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "twt_1",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["not a string", 12],
  ])("rejects a watch_id that is %s", async (_label, watchId) => {
    const { unwatch, unwatchFn } = makeTools();
    const res = await unwatch.handler({ watch_id: watchId });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(unwatchFn).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  const cases: Array<[string, unknown, string, string]> = [
    [
      "auth failures",
      new WatchAuthError("not your task"),
      "watch_auth",
      "not your task",
    ],
    [
      "validation failures",
      new WatchValidationError("too many tasks"),
      "watch_validation",
      "too many tasks",
    ],
    [
      "missing rows",
      new WatchNotFoundError("twt_gone"),
      "watch_not_found",
      "task_watch twt_gone not found",
    ],
    [
      "any other Error",
      new Error("connection reset"),
      "watch_error",
      "connection reset",
    ],
    ["a non-Error throw", "kaboom", "watch_error", "kaboom"],
  ];

  it.each(cases)(
    "watch_tasks maps %s to a coded envelope",
    async (_label, thrown, code, message) => {
      const { watchTasks } = makeTools(
        {},
        {
          watchTasks: vi.fn(async () => {
            throw thrown;
          }),
        },
      );
      const res = await watchTasks.handler({ task_ids: ["tsk_1"] });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message });
    },
  );

  it.each(cases)(
    "unwatch maps %s to a coded envelope",
    async (_label, thrown, code, message) => {
      const { unwatch } = makeTools(
        {},
        {
          unwatch: vi.fn(async () => {
            throw thrown;
          }),
        },
      );
      const res = await unwatch.handler({ watch_id: "twt_1" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message });
    },
  );
});
