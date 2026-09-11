/**
 * watch_tasks + unwatch MCP tools — unit tests with a fake WatchService.
 *
 * The tools are thin adapters, so the risk is concentrated in the two
 * things they do own: coercing agent-supplied input into a valid
 * `WatchTasksInput` (mode defaulting, task_ids filtering, session
 * context), and mapping the four WatchService error classes onto stable
 * `error` codes the calling agent branches on. Both are pinned here.
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
import type { AgentTool } from "./types.js";

const AGENT = "agent_a";
const SESSION = "sess_1";

interface Harness {
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  tools: AgentTool[];
  watch: AgentTool;
  unwatchTool: AgentTool;
}

function harness(
  opts: { ctx?: Partial<WatchToolContext>; throws?: unknown } = {},
): Harness {
  const reject = async (): Promise<never> => {
    throw opts.throws;
  };
  const watchTasks = vi.fn(
    opts.throws
      ? reject
      : async () => ({ watchId: "tw_1", firedImmediately: false }),
  );
  const unwatch = vi.fn(opts.throws ? reject : async () => undefined);
  const watchService = { watchTasks, unwatch } as unknown as WatchService;

  const tools = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...opts.ctx },
    { watchService },
  );
  return {
    watchTasks,
    unwatch,
    tools,
    watch: tools.find((t) => t.name === "watch_tasks")!,
    unwatchTool: tools.find((t) => t.name === "unwatch")!,
  };
}

describe("buildWatchTools descriptors", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const h = harness();
    expect(h.tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the domain's watch modes in the watch_tasks schema", () => {
    const h = harness();
    const props = h.watch.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode!.enum).toEqual([...TASK_WATCH_MODES]);
    expect(h.watch.schema.required).toEqual(["task_ids"]);
  });

  it("requires watch_id on unwatch", () => {
    const h = harness();
    expect(h.unwatchTool.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks input handling", () => {
  it("forwards task_ids with the caller's agent and session ids", async () => {
    const h = harness();
    const result = await h.watch.handler({ task_ids: ["task_1", "task_2"] });

    expect(h.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
    expect(result.isError).toBeFalsy();
  });

  it("defaults mode to 'all' when the value is not a known mode", async () => {
    const h = harness();
    await h.watch.handler({ task_ids: ["task_1"], mode: "first" });

    expect(h.watchTasks.mock.calls[0]![0].mode).toBe("all");
  });

  it("honours an explicit 'any' mode", async () => {
    const h = harness();
    await h.watch.handler({ task_ids: ["task_1"], mode: "any" });

    expect(h.watchTasks.mock.calls[0]![0].mode).toBe("any");
  });

  it("drops non-string entries from task_ids", async () => {
    const h = harness();
    await h.watch.handler({ task_ids: ["task_1", 42, null, "task_2"] });

    expect(h.watchTasks.mock.calls[0]![0].taskIds).toEqual([
      "task_1",
      "task_2",
    ]);
  });

  it.each([
    ["an empty array", []],
    ["a non-array", "task_1"],
    ["an array with no strings left after filtering", [1, 2]],
  ])("rejects task_ids that is %s", async (_label, taskIds) => {
    const h = harness();
    const result = await h.watch.handler({ task_ids: taskIds });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("trims a reason and passes it through", async () => {
    const h = harness();
    await h.watch.handler({ task_ids: ["task_1"], reason: "  check CI  " });

    expect(h.watchTasks.mock.calls[0]![0].reason).toBe("check CI");
  });

  it.each([
    ["blank", "   "],
    ["non-string", 7],
  ])("omits a %s reason", async (_label, reason) => {
    const h = harness();
    await h.watch.handler({ task_ids: ["task_1"], reason });

    expect(h.watchTasks.mock.calls[0]![0].reason).toBeUndefined();
  });

  it("refuses to register a watch outside a session context", async () => {
    const h = harness({ ctx: { sessionId: undefined } });
    const result = await h.watch.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("validates task_ids before the session context", async () => {
    // Ordering matters only in that the agent sees the most actionable
    // problem first; pin it so a refactor can't silently swap them.
    const h = harness({ ctx: { sessionId: undefined } });
    const result = await h.watch.handler({ task_ids: [] });

    expect(result.content).toMatchObject({
      message: "task_ids must be a non-empty array of strings",
    });
  });

  it("returns the watch id and the fired_immediately flag", async () => {
    const h = harness();
    h.watchTasks.mockResolvedValueOnce({
      watchId: "tw_now",
      firedImmediately: true,
    });
    const result = await h.watch.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "tw_now",
      fired_immediately: true,
    });
  });
});

describe("unwatch input handling", () => {
  it("forwards the watch id with the caller's agent id", async () => {
    const h = harness();
    const result = await h.unwatchTool.handler({ watch_id: "tw_1" });

    expect(h.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "tw_1",
    });
    expect(result.content).toEqual({ ok: true });
    expect(result.isError).toBeFalsy();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 5],
  ])("rejects a %s watch_id", async (_label, watchId) => {
    const h = harness();
    const result = await h.unwatchTool.handler({ watch_id: watchId });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(h.unwatch).not.toHaveBeenCalled();
  });
});

describe("WatchService error mapping", () => {
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not your session"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("tw_9"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
    ["a non-Error throw", "kaboom", "watch_error"],
  ];

  it.each(cases)("watch_tasks maps %s to %s", async (_label, thrown, code) => {
    const h = harness({ throws: thrown });
    const result = await h.watch.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
    expect(typeof (result.content as { message: string }).message).toBe(
      "string",
    );
  });

  it.each(cases)("unwatch maps %s to %s", async (_label, thrown, code) => {
    const h = harness({ throws: thrown });
    const result = await h.unwatchTool.handler({ watch_id: "tw_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });

  it("keeps the service's message on a mapped error", async () => {
    const h = harness({ throws: new WatchAuthError("not your session") });
    const result = await h.watch.handler({ task_ids: ["task_1"] });

    expect(result.content).toMatchObject({
      error: "watch_auth",
      message: "not your session",
    });
  });

  it("formats WatchNotFoundError's generated message", async () => {
    const h = harness({ throws: new WatchNotFoundError("tw_9") });
    const result = await h.unwatchTool.handler({ watch_id: "tw_9" });

    expect(result.content).toMatchObject({
      error: "watch_not_found",
      message: "task_watch tw_9 not found",
    });
  });
});
