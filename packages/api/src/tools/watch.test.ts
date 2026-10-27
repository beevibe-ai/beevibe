/**
 * watch_tasks + unwatch tools — unit tests with vitest fakes (no DB).
 *
 * Both tools are thin adapters over WatchService, so what is worth
 * pinning here is exactly the part the service never sees: the input
 * coercion (which shapes survive, which are rejected before a round
 * trip), the `mode` default, the session-context precondition, and the
 * mapping from each WatchService error class to its stable `error` code.
 * The agent branches on those codes, so a renamed code is a wire break.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type UnwatchInput,
  type WatchService,
  type WatchTasksInput,
  type WatchTasksResult,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

function makeServices(
  overrides: {
    watchTasks?: (input: WatchTasksInput) => Promise<WatchTasksResult>;
    unwatch?: (input: UnwatchInput) => Promise<void>;
  } = {},
) {
  const watchTasks = vi.fn<(input: WatchTasksInput) => Promise<WatchTasksResult>>(
    overrides.watchTasks ??
      (async () => ({ watchId: "tw_1", firedImmediately: false })),
  );
  const unwatch = vi.fn<(input: UnwatchInput) => Promise<void>>(
    overrides.unwatch ?? (async () => {}),
  );
  return {
    watchTasks,
    unwatch,
    services: {
      watchService: { watchTasks, unwatch } as unknown as WatchService,
    },
  };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function tools(
  fakes: ReturnType<typeof makeServices>,
  ctx: WatchToolContext = CTX,
) {
  const built = buildWatchTools(ctx, fakes.services);
  const byName = new Map(built.map((t) => [t.name, t]));
  return {
    all: built,
    watchTasks: byName.get("watch_tasks")!,
    unwatch: byName.get("unwatch")!,
  };
}

describe("buildWatchTools surface", () => {
  it("returns watch_tasks then unwatch, in that order", () => {
    const built = buildWatchTools(CTX, makeServices().services);
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises every supported mode in the watch_tasks schema enum", () => {
    const { watchTasks } = tools(makeServices());
    const mode = (
      watchTasks.schema.properties as Record<string, { enum?: string[] }>
    ).mode!;
    // The enum is spread from TASK_WATCH_MODES — if a mode is added to the
    // domain without the tool's `isMode` guard keeping up, agents can pass
    // a mode the handler silently rewrites to "all".
    expect(mode.enum).toEqual(["all", "any"]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks input handling", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const fakes = makeServices();
    const result = await tools(fakes).watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the failing one first  ",
    });

    expect(fakes.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need the failing one first",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "tw_1",
      fired_immediately: false,
    });
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const fakes = makeServices({
      watchTasks: async () => ({ watchId: "tw_now", firedImmediately: true }),
    });
    const result = await tools(fakes).watchTasks.handler({
      task_ids: ["task_done"],
    });

    expect(result.content).toEqual({
      watch_id: "tw_now",
      fired_immediately: true,
    });
  });

  it("defaults mode to all", async () => {
    const fakes = makeServices();
    await tools(fakes).watchTasks.handler({ task_ids: ["task_1"] });

    expect(fakes.watchTasks.mock.calls[0]![0]).toMatchObject({ mode: "all" });
  });

  it.each([
    ["an unknown string", "first"],
    ["a non-string", 1],
    ["null", null],
  ])("falls back to all when mode is %s", async (_label, mode) => {
    const fakes = makeServices();
    await tools(fakes).watchTasks.handler({ task_ids: ["task_1"], mode });

    expect(fakes.watchTasks.mock.calls[0]![0]).toMatchObject({ mode: "all" });
  });

  it("drops non-string entries from task_ids rather than forwarding them", async () => {
    const fakes = makeServices();
    await tools(fakes).watchTasks.handler({
      task_ids: ["task_1", 42, null, "task_2", { id: "task_3" }],
    });

    expect(fakes.watchTasks.mock.calls[0]![0]).toMatchObject({
      taskIds: ["task_1", "task_2"],
    });
  });

  it.each([
    ["absent", undefined],
    ["an empty array", []],
    ["a non-array", "task_1"],
    ["an array with no strings in it", [1, null, {}]],
  ])(
    "rejects task_ids that are %s without calling the service",
    async (_label, task_ids) => {
      const fakes = makeServices();
      const result = await tools(fakes).watchTasks.handler({ task_ids });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "watch_validation",
        message: "task_ids must be a non-empty array of strings",
      });
      expect(fakes.watchTasks).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["a non-string", 9],
  ])("omits a %s reason instead of forwarding it", async (_label, reason) => {
    const fakes = makeServices();
    await tools(fakes).watchTasks.handler({ task_ids: ["task_1"], reason });

    expect(fakes.watchTasks.mock.calls[0]![0].reason).toBeUndefined();
  });

  // Without a session id the service cannot identify who to wake, so the
  // handler has to refuse rather than insert an unwakeable watch row.
  it("refuses when there is no session in context", async () => {
    const fakes = makeServices();
    const result = await tools(fakes, { agentId: "agent_a" }).watchTasks.handler(
      { task_ids: ["task_1"] },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(fakes.watchTasks).not.toHaveBeenCalled();
  });

  it("checks task_ids before the session precondition", async () => {
    const fakes = makeServices();
    const result = await tools(fakes, { agentId: "agent_a" }).watchTasks.handler(
      { task_ids: [] },
    );

    expect(result.content).toMatchObject({
      message: "task_ids must be a non-empty array of strings",
    });
  });
});

describe("unwatch input handling", () => {
  it("forwards the watch id with the caller agent id", async () => {
    const fakes = makeServices();
    const result = await tools(fakes).unwatch.handler({ watch_id: "tw_1" });

    expect(fakes.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("works without a session in context — unwatch needs only the agent", async () => {
    const fakes = makeServices();
    const result = await tools(fakes, { agentId: "agent_a" }).unwatch.handler({
      watch_id: "tw_1",
    });

    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["a non-string", 1],
  ])("rejects a watch_id that is %s", async (_label, watch_id) => {
    const fakes = makeServices();
    const result = await tools(fakes).unwatch.handler({ watch_id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(fakes.unwatch).not.toHaveBeenCalled();
  });
});

// One shared `caughtError` maps thrown service errors onto wire codes for
// both tools, so both tools are driven through every branch of it.
describe.each([
  [
    "watch_tasks",
    (f: ReturnType<typeof makeServices>) => f.watchTasks,
    (f: ReturnType<typeof makeServices>) =>
      tools(f).watchTasks.handler({ task_ids: ["task_1"] }),
  ],
  [
    "unwatch",
    (f: ReturnType<typeof makeServices>) => f.unwatch,
    (f: ReturnType<typeof makeServices>) =>
      tools(f).unwatch.handler({ watch_id: "tw_1" }),
  ],
] as const)("%s error mapping", (_name, pickMock, call) => {
  function failing(err: unknown) {
    const fakes = makeServices();
    pickMock(fakes).mockImplementation(async () => {
      throw err;
    });
    return fakes;
  }

  it("maps WatchAuthError to watch_auth", async () => {
    const result = await call(
      failing(new WatchAuthError("task_7 is not in your chain")),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "watch_auth",
      message: "task_7 is not in your chain",
    });
  });

  it("maps WatchValidationError to watch_validation", async () => {
    const result = await call(failing(new WatchValidationError("bad mode")));

    expect(result.content).toEqual({
      error: "watch_validation",
      message: "bad mode",
    });
  });

  it("maps WatchNotFoundError to watch_not_found", async () => {
    const result = await call(failing(new WatchNotFoundError("tw_missing")));

    expect(result.content).toEqual({
      error: "watch_not_found",
      message: "task_watch tw_missing not found",
    });
  });

  it("maps an unexpected Error to watch_error, keeping its message", async () => {
    const result = await call(failing(new Error("connection terminated")));

    expect(result.content).toEqual({
      error: "watch_error",
      message: "connection terminated",
    });
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    const result = await call(failing("pool drained"));

    expect(result.content).toEqual({
      error: "watch_error",
      message: "pool drained",
    });
  });
});
