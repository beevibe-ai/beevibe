/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters: the service does the auth check, the
 * insert and the already-terminal race fire. What lives *here* is the
 * input coercion (what counts as a task id, what a missing mode
 * defaults to) and the error-class → error-code mapping the calling
 * agent branches on. WatchService itself needs Postgres to test, so
 * these run against a fake and pin the adapter half.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Harness {
  tools: ReturnType<typeof buildWatchTools>;
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
}

function harness(
  ctx: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" },
  behavior: { watchThrows?: unknown; unwatchThrows?: unknown } = {},
): Harness {
  const watchTasks = vi.fn(async () => {
    if ("watchThrows" in behavior) throw behavior.watchThrows;
    return { watchId: "tw_minted", firedImmediately: false };
  });
  const unwatch = vi.fn(async () => {
    if ("unwatchThrows" in behavior) throw behavior.unwatchThrows;
  });
  const watchService = { watchTasks, unwatch } as unknown as WatchService;
  return {
    tools: buildWatchTools(ctx, { watchService }),
    watchTasks,
    unwatch,
  };
}

const watchTasksTool = (h: Harness) => h.tools[0]!;
const unwatchTool = (h: Harness) => h.tools[1]!;

describe("buildWatchTools", () => {
  it("returns watch_tasks then unwatch", () => {
    expect(harness().tools.map((t) => t.name)).toEqual([
      "watch_tasks",
      "unwatch",
    ]);
  });

  it("advertises the three watch modes on watch_tasks", () => {
    const schema = watchTasksTool(harness()).schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.required).toEqual(["task_ids"]);
    expect(schema.properties.mode.enum).toEqual(
      expect.arrayContaining(["all", "any"]),
    );
  });
});

describe("watch_tasks — input coercion", () => {
  it("forwards the caller's agent + session ids alongside the task ids", async () => {
    const h = harness();
    const result = await watchTasksTool(h).handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need both results  ",
    });

    expect(h.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need both results",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "tw_minted",
      fired_immediately: false,
    });
  });

  it("reports fired_immediately when the tasks were already terminal", async () => {
    const h = harness();
    h.watchTasks.mockResolvedValueOnce({
      watchId: "tw_race",
      firedImmediately: true,
    });

    const result = await watchTasksTool(h).handler({ task_ids: ["task_1"] });
    expect(result.content).toEqual({
      watch_id: "tw_race",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all'", async () => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_1"] });
    expect(h.watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("falls back to 'all' for a mode outside the enum", async () => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_1"], mode: "either" });
    expect(h.watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it.each([
    ["omitted", undefined],
    ["blank", "   "],
    ["a non-string", 7],
  ])("sends no reason when it is %s", async (_label, reason) => {
    const h = harness();
    await watchTasksTool(h).handler({
      task_ids: ["task_1"],
      ...(reason === undefined ? {} : { reason }),
    });
    expect(h.watchTasks.mock.calls[0]?.[0]).toMatchObject({
      reason: undefined,
    });
  });

  it("drops non-string entries from task_ids", async () => {
    const h = harness();
    await watchTasksTool(h).handler({
      task_ids: ["task_1", 42, null, "task_2"],
    });
    expect(h.watchTasks.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["task_1", "task_2"],
    });
  });

  it.each([
    ["missing", undefined],
    ["an empty array", []],
    ["a bare string", "task_1"],
    ["all non-strings", [1, 2, 3]],
  ])("rejects task_ids that are %s without calling the service", async (_label, taskIds) => {
    const h = harness();
    const result = await watchTasksTool(h).handler(
      taskIds === undefined ? {} : { task_ids: taskIds },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch outside a session context", async () => {
    const h = harness({ agentId: "agent_a" });
    const result = await watchTasksTool(h).handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: expect.stringContaining("session context"),
    });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });
});

describe("unwatch", () => {
  it("delegates with the caller's agent id and reports ok", async () => {
    const h = harness();
    const result = await unwatchTool(h).handler({ watch_id: "tw_1" });

    expect(h.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["a non-string", 12],
  ])("rejects a watch_id that is %s", async (_label, watchId) => {
    const h = harness();
    const result = await unwatchTool(h).handler(
      watchId === undefined ? {} : { watch_id: watchId },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.unwatch).not.toHaveBeenCalled();
  });
});

describe("error-class → error-code mapping", () => {
  // The agent branches on `error`, so each service failure has to keep
  // its own code rather than collapsing into the generic one.
  it.each([
    [new WatchAuthError("not your task"), "watch_auth", "not your task"],
    [
      new WatchValidationError("mode must be all|any"),
      "watch_validation",
      "mode must be all|any",
    ],
    [new WatchNotFoundError("tw_9"), "watch_not_found", "task_watch tw_9 not found"],
    [new Error("connection reset"), "watch_error", "connection reset"],
    ["a bare string throw", "watch_error", "a bare string throw"],
  ])("maps %o to %s", async (thrown, code, message) => {
    const watched = harness(
      { agentId: "agent_a", sessionId: "ses_1" },
      { watchThrows: thrown },
    );
    const watchResult = await watchTasksTool(watched).handler({
      task_ids: ["task_1"],
    });
    expect(watchResult.isError).toBe(true);
    expect(watchResult.content).toEqual({ error: code, message });

    // unwatch shares the same mapper, so it must agree.
    const unwatched = harness(
      { agentId: "agent_a", sessionId: "ses_1" },
      { unwatchThrows: thrown },
    );
    const unwatchResult = await unwatchTool(unwatched).handler({
      watch_id: "tw_1",
    });
    expect(unwatchResult.content).toEqual({ error: code, message });
  });
});
