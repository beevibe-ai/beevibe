/**
 * watch_tasks + unwatch MCP tools — unit tests with vitest fakes (no DB).
 *
 * Both are thin adapters over WatchService, so the logic that lives here
 * (and can therefore regress here) is exactly: input coercion, the
 * missing-session guard, mode defaulting, and the error-class → error-code
 * mapping. A miscoded error is the expensive one — the agent branches on
 * `error`, so a `watch_auth` that degrades to `watch_error` silently turns
 * a permission bug into a retry loop.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools } from "./watch.js";
import type { AgentTool } from "./types.js";

const AGENT = "agent_a";
const SESSION = "sess_1";

function buildTools(
  overrides: Partial<WatchService> = {},
  ctx: { agentId: string; sessionId?: string } = {
    agentId: AGENT,
    sessionId: SESSION,
  },
) {
  const watchService = {
    watchTasks: vi.fn(async () => ({ watchId: "tw_1", firedImmediately: false })),
    unwatch: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WatchService;

  const tools = buildWatchTools(ctx, { watchService });
  const byName = (name: string): AgentTool => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return tool;
  };
  return { tools, watchService, watchTasks: byName("watch_tasks"), unwatch: byName("unwatch") };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { tools } = buildTools();

    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the fire modes on the schema so the agent can pick one", () => {
    const { watchTasks, unwatch } = buildTools();
    const props = watchTasks.schema.properties as Record<string, { enum?: string[] }>;

    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, ids, mode and reason to the service", async () => {
    const { watchTasks, watchService } = buildTools();

    const result = await watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "tw_1", fired_immediately: false });
  });

  it("reports fired_immediately when the tasks were already terminal", async () => {
    const { watchTasks } = buildTools({
      watchTasks: vi.fn(async () => ({ watchId: "tw_9", firedImmediately: true })),
    });

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({ watch_id: "tw_9", fired_immediately: true });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const { watchTasks, watchService } = buildTools();

    await watchTasks.handler({ task_ids: ["task_1"] });
    await watchTasks.handler({ task_ids: ["task_1"], mode: "either" });
    await watchTasks.handler({ task_ids: ["task_1"], mode: 7 });

    const modes = vi
      .mocked(watchService.watchTasks)
      .mock.calls.map(([input]) => input.mode);
    expect(modes).toEqual(["all", "all", "all"]);
  });

  it("drops a blank reason rather than passing an empty string through", async () => {
    const { watchTasks, watchService } = buildTools();

    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    await watchTasks.handler({ task_ids: ["task_1"], reason: 42 });

    for (const [input] of vi.mocked(watchService.watchTasks).mock.calls) {
      expect(input.reason).toBeUndefined();
    }
  });

  it("keeps only the string entries of task_ids", async () => {
    const { watchTasks, watchService } = buildTools();

    await watchTasks.handler({ task_ids: ["task_1", 2, null, "task_3"] });

    expect(vi.mocked(watchService.watchTasks).mock.calls[0]?.[0].taskIds).toEqual([
      "task_1",
      "task_3",
    ]);
  });

  it.each([
    ["an empty array", []],
    ["a non-array", "task_1"],
    ["an array with no strings", [1, 2]],
    ["nothing", undefined],
  ])("rejects %s for task_ids without calling the service", async (_label, taskIds) => {
    const { watchTasks, watchService } = buildTools();

    const result = await watchTasks.handler({ task_ids: taskIds });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch outside a session context", async () => {
    const { watchTasks, watchService } = buildTools({}, { agentId: AGENT });

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });
});

describe("unwatch", () => {
  it("cancels the watch for the calling agent", async () => {
    const { unwatch, watchService } = buildTools();

    const result = await unwatch.handler({ watch_id: "tw_1" });

    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 7],
    ["nothing", undefined],
  ])("rejects %s for watch_id without calling the service", async (_label, watchId) => {
    const { unwatch, watchService } = buildTools();

    const result = await unwatch.handler({ watch_id: watchId });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });
});

describe("service error mapping", () => {
  const cases: Array<[string, () => unknown, string, string]> = [
    [
      "WatchAuthError",
      () => new WatchAuthError("task task_1 is not yours"),
      "watch_auth",
      "task task_1 is not yours",
    ],
    [
      "WatchValidationError",
      () => new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
      "task_ids must be non-empty",
    ],
    [
      "WatchNotFoundError",
      () => new WatchNotFoundError("tw_missing"),
      "watch_not_found",
      "task_watch tw_missing not found",
    ],
    [
      "a plain Error",
      () => new Error("connection reset"),
      "watch_error",
      "connection reset",
    ],
    ["a thrown string", () => "kaput", "watch_error", "kaput"],
  ];

  it.each(cases)("maps %s thrown by watchTasks", async (_label, make, code, message) => {
    const { watchTasks } = buildTools({
      watchTasks: vi.fn(async () => {
        throw make();
      }),
    });

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message });
  });

  it.each(cases)("maps %s thrown by unwatch", async (_label, make, code, message) => {
    const { unwatch } = buildTools({
      unwatch: vi.fn(async () => {
        throw make();
      }),
    });

    const result = await unwatch.handler({ watch_id: "tw_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message });
  });
});
