/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService — the value here is the
 * adapter layer: input coercion (mode defaulting, task_ids filtering,
 * reason trimming), the session-context guard, and the mapping from the
 * service's typed errors onto stable MCP error codes agents branch on.
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

interface Harness {
  watchTasks: Array<Record<string, unknown>>;
  unwatches: Array<Record<string, unknown>>;
  tools: Record<string, AgentTool>;
}

function build(
  ctx: Partial<WatchToolContext> = {},
  behavior: {
    watchResult?: { watchId: string; firedImmediately: boolean };
    watchError?: unknown;
    unwatchError?: unknown;
  } = {},
): Harness {
  const watchTasks: Array<Record<string, unknown>> = [];
  const unwatches: Array<Record<string, unknown>> = [];

  const watchService = {
    watchTasks: vi.fn(async (input: Record<string, unknown>) => {
      watchTasks.push(input);
      if (behavior.watchError) throw behavior.watchError;
      return (
        behavior.watchResult ?? { watchId: "tw_1", firedImmediately: false }
      );
    }),
    unwatch: vi.fn(async (input: Record<string, unknown>) => {
      unwatches.push(input);
      if (behavior.unwatchError) throw behavior.unwatchError;
    }),
  } as unknown as WatchService;

  const tools = buildWatchTools(
    { agentId: "agent_team", sessionId: "ses_1", ...ctx },
    { watchService },
  );
  return {
    watchTasks,
    unwatches,
    tools: Object.fromEntries(tools.map((t) => [t.name, t])),
  };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { tools } = build();
    expect(Object.keys(tools)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares the required schema fields", () => {
    const { tools } = build();
    expect(tools.watch_tasks!.schema.required).toEqual(["task_ids"]);
    expect(tools.unwatch!.schema.required).toEqual(["watch_id"]);
  });

  it("enumerates the supported modes in the schema", () => {
    const { tools } = build();
    const props = tools.watch_tasks!.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const { tools, watchTasks } = build();
    const result = await tools.watch_tasks!.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(watchTasks).toEqual([
      {
        callerAgentId: "agent_team",
        callerSessionId: "ses_1",
        taskIds: ["task_a", "task_b"],
        mode: "any",
        reason: "need the first result",
      },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "tw_1",
      fired_immediately: false,
    });
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const { tools } = build(
      {},
      { watchResult: { watchId: "tw_hot", firedImmediately: true } },
    );
    const result = await tools.watch_tasks!.handler({ task_ids: ["task_a"] });

    expect(result.content).toEqual({
      watch_id: "tw_hot",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const { tools, watchTasks } = build();
    await tools.watch_tasks!.handler({ task_ids: ["task_a"] });
    await tools.watch_tasks!.handler({ task_ids: ["task_a"], mode: "either" });
    await tools.watch_tasks!.handler({ task_ids: ["task_a"], mode: 1 });

    expect(watchTasks.map((c) => c.mode)).toEqual(["all", "all", "all"]);
  });

  it("keeps an explicit 'all' mode", async () => {
    const { tools, watchTasks } = build();
    await tools.watch_tasks!.handler({ task_ids: ["task_a"], mode: "all" });
    expect(watchTasks[0]?.mode).toBe("all");
  });

  it.each([
    ["omitted", undefined],
    ["blank", "   "],
    ["a non-string", 5],
  ])("sends reason as undefined when it is %s", async (_label, reason) => {
    const { tools, watchTasks } = build();
    await tools.watch_tasks!.handler({
      task_ids: ["task_a"],
      reason,
    } as Record<string, unknown>);
    expect(watchTasks[0]?.reason).toBeUndefined();
  });

  it("drops non-string entries from task_ids", async () => {
    const { tools, watchTasks } = build();
    await tools.watch_tasks!.handler({
      task_ids: ["task_a", 7, null, "task_b"],
    });
    expect(watchTasks[0]?.taskIds).toEqual(["task_a", "task_b"]);
  });

  it.each([
    ["an empty array", []],
    ["an all-non-string array", [1, 2]],
    ["a non-array", "task_a"],
    ["omitted", undefined],
  ])("rejects %s task_ids without calling the service", async (_label, taskIds) => {
    const { tools, watchTasks } = build();
    const result = await tools.watch_tasks!.handler({ task_ids: taskIds } as Record<
      string,
      unknown
    >);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).toHaveLength(0);
  });

  it("refuses to register a watch outside a session context", async () => {
    const { tools, watchTasks } = build({ sessionId: undefined });
    const result = await tools.watch_tasks!.handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchTasks).toHaveLength(0);
  });

  it.each([
    [new WatchAuthError("not your chain"), "watch_auth", "not your chain"],
    [new WatchValidationError("bad mode"), "watch_validation", "bad mode"],
    [new WatchNotFoundError("tw_9"), "watch_not_found", "task_watch tw_9 not found"],
    [new Error("pool exhausted"), "watch_error", "pool exhausted"],
    ["plain string throw", "watch_error", "plain string throw"],
  ])("maps a thrown %# onto a stable error code", async (thrown, code, message) => {
    const { tools } = build({}, { watchError: thrown });
    const result = await tools.watch_tasks!.handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code, message });
  });
});

describe("unwatch", () => {
  it("forwards the caller agent and watch id", async () => {
    const { tools, unwatches } = build();
    const result = await tools.unwatch!.handler({ watch_id: "tw_1" });

    expect(unwatches).toEqual([
      { callerAgentId: "agent_team", watchId: "tw_1" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["a non-string", 3],
  ])("rejects %s watch_id without calling the service", async (_label, watchId) => {
    const { tools, unwatches } = build();
    const result = await tools.unwatch!.handler({ watch_id: watchId } as Record<
      string,
      unknown
    >);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(unwatches).toHaveLength(0);
  });

  it("works without a session context — unwatch only needs the agent", async () => {
    const { tools, unwatches } = build({ sessionId: undefined });
    const result = await tools.unwatch!.handler({ watch_id: "tw_1" });

    expect(result.content).toEqual({ ok: true });
    expect(unwatches).toHaveLength(1);
  });

  it.each([
    [new WatchNotFoundError("tw_gone"), "watch_not_found"],
    [new WatchAuthError("not yours"), "watch_auth"],
    [new WatchValidationError("already fired"), "watch_validation"],
    [new Error("boom"), "watch_error"],
    [{ code: 42 }, "watch_error"],
  ])("maps a thrown %# onto a stable error code", async (thrown, code) => {
    const { tools } = build({}, { unwatchError: thrown });
    const result = await tools.unwatch!.handler({ watch_id: "tw_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });
});
