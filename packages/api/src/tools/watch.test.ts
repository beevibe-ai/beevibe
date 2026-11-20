/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check, the insert, the already-terminal race and the unwatch
 * state machine, and its own suite (core, DB-gated) covers that. What
 * lives *here* is everything the adapter does on its own and nothing
 * else exercises: input coercion (task_ids filtering, mode fallback,
 * reason trimming), the two pre-flight validations, the exact argument
 * object handed to the service, and the error-class → error-code map in
 * `caughtError`.
 *
 * That map is the reason these tests matter beyond line count: the
 * codes (`watch_auth`, `watch_validation`, `watch_not_found`,
 * `watch_error`) are a wire contract the calling agent branches on, and
 * nothing but an `instanceof` chain keeps them pinned to the right
 * exception.
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

const DEFAULT_CTX: WatchToolContext = {
  agentId: "agent_team",
  sessionId: "ses_caller",
};

function tools(
  ctx: Partial<WatchToolContext> = {},
  overrides: Partial<{
    watchTasks: WatchService["watchTasks"];
    unwatch: WatchService["unwatch"];
  }> = {},
) {
  // The parameter types are explicit so `mock.calls[0][0]` stays typed
  // as the service input rather than inferring a zero-arg signature.
  const watchTasks = vi.fn(async (_input: WatchTasksInput) => ({
    watchId: "tw_minted",
    firedImmediately: false,
  }));
  const unwatch = vi.fn(async (_input: UnwatchInput) => undefined);
  const watchService = {
    watchTasks: overrides.watchTasks ?? watchTasks,
    unwatch: overrides.unwatch ?? unwatch,
  } as unknown as WatchService;

  const [watchTasksTool, unwatchTool] = buildWatchTools(
    { ...DEFAULT_CTX, ...ctx },
    { watchService },
  );
  // buildWatchTools returns a fixed-length pair; the non-null assertions
  // keep the test bodies free of `?.` noise on every call.
  return {
    watchTasksTool: watchTasksTool!,
    unwatchTool: unwatchTool!,
    watchTasks,
    unwatch,
  };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks then unwatch, in that order", () => {
    const { watchTasksTool, unwatchTool } = tools();
    expect(watchTasksTool.name).toBe("watch_tasks");
    expect(unwatchTool.name).toBe("unwatch");
  });

  it("declares the agent-facing schema contract", () => {
    const { watchTasksTool, unwatchTool } = tools();
    expect(watchTasksTool.schema.required).toEqual(["task_ids"]);
    // The mode enum is generated from TASK_WATCH_MODES — assert the
    // values so a domain-level rename can't silently drop one from the
    // tool surface.
    const props = watchTasksTool.schema.properties as Record<
      string,
      { enum?: string[]; minItems?: number }
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(props.task_ids?.minItems).toBe(1);
    expect(unwatchTool.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks handler", () => {
  it("passes caller identity + parsed input through and projects the result", async () => {
    const { watchTasksTool, watchTasks } = tools();

    const result = await watchTasksTool.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need both reviews  ",
    });

    expect(watchTasks).toHaveBeenCalledTimes(1);
    expect(watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_team",
      callerSessionId: "ses_caller",
      taskIds: ["task_a", "task_b"],
      mode: "any",
      // Trimmed, not passed through raw.
      reason: "need both reviews",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "tw_minted",
      fired_immediately: false,
    });
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const { watchTasksTool } = tools(
      {},
      {
        watchTasks: vi.fn(async () => ({
          watchId: "tw_raced",
          firedImmediately: true,
        })) as unknown as WatchService["watchTasks"],
      },
    );

    const result = await watchTasksTool.handler({ task_ids: ["task_a"] });

    expect(result.content).toEqual({
      watch_id: "tw_raced",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const { watchTasksTool, watchTasks } = tools();
    await watchTasksTool.handler({ task_ids: ["task_a"] });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("falls back to 'all' for a mode outside the enum rather than erroring", async () => {
    const { watchTasksTool, watchTasks } = tools();
    // "either" is not a TaskWatchMode. The handler coerces instead of
    // rejecting, so an agent that invents a mode still gets a watch.
    await watchTasksTool.handler({ task_ids: ["task_a"], mode: "either" });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("falls back to 'all' for a non-string mode", async () => {
    const { watchTasksTool, watchTasks } = tools();
    await watchTasksTool.handler({ task_ids: ["task_a"], mode: 7 });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("drops a whitespace-only reason to undefined", async () => {
    const { watchTasksTool, watchTasks } = tools();
    await watchTasksTool.handler({ task_ids: ["task_a"], reason: "   " });
    expect(watchTasks.mock.calls[0]?.[0].reason).toBeUndefined();
  });

  it("drops a non-string reason to undefined", async () => {
    const { watchTasksTool, watchTasks } = tools();
    await watchTasksTool.handler({ task_ids: ["task_a"], reason: { a: 1 } });
    expect(watchTasks.mock.calls[0]?.[0].reason).toBeUndefined();
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watchTasksTool, watchTasks } = tools();
    await watchTasksTool.handler({
      task_ids: ["task_a", 42, null, "task_b", undefined],
    });
    expect(watchTasks.mock.calls[0]?.[0].taskIds).toEqual([
      "task_a",
      "task_b",
    ]);
  });

  it("rejects an empty task_ids array without calling the service", async () => {
    const { watchTasksTool, watchTasks } = tools();
    const result = await watchTasksTool.handler({ task_ids: [] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "task_ids must be a non-empty array of strings",
    });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a task_ids array that filters down to empty", async () => {
    const { watchTasksTool, watchTasks } = tools();
    const result = await watchTasksTool.handler({ task_ids: [1, 2, 3] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a non-array task_ids", async () => {
    const { watchTasksTool, watchTasks } = tools();
    const result = await watchTasksTool.handler({ task_ids: "task_a" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a missing task_ids", async () => {
    const { watchTasksTool, watchTasks } = tools();
    const result = await watchTasksTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch with no session context", async () => {
    // Without a beevibe session id there is no waiter to chain the wake
    // session off, so the service is never reached.
    const { watchTasksTool, watchTasks } = tools({ sessionId: undefined });

    const result = await watchTasksTool.handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("checks task_ids before session context", async () => {
    // Both guards raise watch_validation, so only the message
    // distinguishes them. Pinning the precedence keeps the agent-facing
    // diagnostic stable when a call is wrong in both ways at once.
    const { watchTasksTool } = tools({ sessionId: undefined });
    const result = await watchTasksTool.handler({ task_ids: [] });
    expect(result.content).toMatchObject({
      message: "task_ids must be a non-empty array of strings",
    });
  });

  it.each([
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("task not terminal-able"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("tw_1"), "watch_not_found"],
    ["plain Error", new Error("pool exhausted"), "watch_error"],
  ])("maps a thrown %s to error code %s", async (_label, thrown, code) => {
    const { watchTasksTool } = tools(
      {},
      {
        watchTasks: vi.fn(async () => {
          throw thrown;
        }) as unknown as WatchService["watchTasks"],
      },
    );

    const result = await watchTasksTool.handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: code,
      message: (thrown as Error).message,
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { watchTasksTool } = tools(
      {},
      {
        watchTasks: vi.fn(async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "pg down";
        }) as unknown as WatchService["watchTasks"],
      },
    );

    const result = await watchTasksTool.handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "pg down",
    });
  });
});

describe("unwatch handler", () => {
  it("delegates to the service with the caller's agent id", async () => {
    const { unwatchTool, unwatch } = tools();

    const result = await unwatchTool.handler({ watch_id: "tw_1" });

    expect(unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_team",
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects an empty watch_id without calling the service", async () => {
    const { unwatchTool, unwatch } = tools();
    const result = await unwatchTool.handler({ watch_id: "" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("rejects a non-string watch_id", async () => {
    const { unwatchTool, unwatch } = tools();
    const result = await unwatchTool.handler({ watch_id: 123 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("rejects a missing watch_id", async () => {
    const { unwatchTool, unwatch } = tools();
    const result = await unwatchTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(unwatch).not.toHaveBeenCalled();
  });

  it.each([
    ["WatchAuthError", new WatchAuthError("not yours"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("already fired"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("tw_9"), "watch_not_found"],
    ["plain Error", new Error("boom"), "watch_error"],
  ])("maps a thrown %s to error code %s", async (_label, thrown, code) => {
    const { unwatchTool } = tools(
      {},
      {
        unwatch: vi.fn(async () => {
          throw thrown;
        }) as unknown as WatchService["unwatch"],
      },
    );

    const result = await unwatchTool.handler({ watch_id: "tw_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: code,
      message: (thrown as Error).message,
    });
  });

  it("stringifies a non-Error throw", async () => {
    const { unwatchTool } = tools(
      {},
      {
        unwatch: vi.fn(async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 404;
        }) as unknown as WatchService["unwatch"],
      },
    );

    const result = await unwatchTool.handler({ watch_id: "tw_1" });

    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "404",
    });
  });
});
