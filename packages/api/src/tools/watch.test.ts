/**
 * Unit tests for the `watch_tasks` + `unwatch` MCP tools.
 *
 * Both are thin adapters over WatchService, so these tests cover the
 * adapter's own three jobs and stub the service out entirely:
 *
 *   1. input coercion (task_ids filtering, mode defaulting, reason trimming),
 *   2. the session-context precondition watch_tasks needs to name a waiter,
 *   3. the WatchService error class -> tool error code mapping.
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

interface Harness {
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  watchTasksTool: AgentTool;
  unwatchTool: AgentTool;
  tools: AgentTool[];
}

function harness(
  ctx: WatchToolContext = { agentId: "agent_caller", sessionId: "sess_caller" },
  opts: { watchThrows?: unknown; unwatchThrows?: unknown } = {},
): Harness {
  const watchTasks = vi.fn(async () => {
    if (opts.watchThrows !== undefined) throw opts.watchThrows;
    return { watchId: "watch_1", firedImmediately: false };
  });
  const unwatch = vi.fn(async () => {
    if (opts.unwatchThrows !== undefined) throw opts.unwatchThrows;
  });

  const tools = buildWatchTools(ctx, {
    watchService: { watchTasks, unwatch } as unknown as WatchService,
  });

  return {
    watchTasks,
    unwatch,
    tools,
    watchTasksTool: tools[0]!,
    unwatchTool: tools[1]!,
  };
}

describe("buildWatchTools — surface", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const h = harness();
    expect(h.tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises every supported mode in the watch_tasks schema", () => {
    const h = harness();
    const props = h.watchTasksTool.schema.properties as Record<
      string,
      { enum?: string[]; minItems?: number }
    >;
    expect(props.mode?.enum).toEqual([...TASK_WATCH_MODES]);
    expect(props.task_ids?.minItems).toBe(1);
    expect(h.watchTasksTool.schema.required).toEqual(["task_ids"]);
  });

  it("requires watch_id on unwatch", () => {
    const h = harness();
    expect(h.unwatchTool.schema.required).toEqual(["watch_id"]);
    expect(h.unwatchTool.description).toContain("Idempotent");
  });
});

describe("watch_tasks — task_ids coercion", () => {
  it.each([
    ["missing", undefined],
    ["an empty array", []],
    ["not an array", "task_1"],
    ["an array with no strings", [1, null, { id: "task_1" }]],
  ])("rejects %s with watch_validation", async (_label, task_ids) => {
    const h = harness();
    const result = await h.watchTasksTool.handler({ task_ids });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("drops non-string entries but proceeds when at least one survives", async () => {
    const h = harness();
    const result = await h.watchTasksTool.handler({
      task_ids: ["task_1", 2, null, "task_2", undefined],
    });

    expect(result.isError).toBeFalsy();
    expect(h.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_1", "task_2"] }),
    );
  });
});

describe("watch_tasks — mode and reason", () => {
  it("defaults mode to 'all' when omitted", async () => {
    const h = harness();
    await h.watchTasksTool.handler({ task_ids: ["task_1"] });

    expect(h.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it.each([...TASK_WATCH_MODES])("passes the valid mode %s through", async (mode) => {
    const h = harness();
    await h.watchTasksTool.handler({ task_ids: ["task_1"], mode });

    expect(h.watchTasks).toHaveBeenCalledWith(expect.objectContaining({ mode }));
  });

  it.each([
    ["an unknown string", "first"],
    ["a non-string", 1],
    ["null", null],
  ])("falls back to 'all' for %s", async (_label, mode) => {
    const h = harness();
    await h.watchTasksTool.handler({ task_ids: ["task_1"], mode });

    expect(h.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("trims a provided reason", async () => {
    const h = harness();
    await h.watchTasksTool.handler({
      task_ids: ["task_1"],
      reason: "  waiting on the migration  ",
    });

    expect(h.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "waiting on the migration" }),
    );
  });

  it.each([
    ["omitted", undefined],
    ["whitespace only", "   "],
    ["a non-string", 5],
  ])("sends reason undefined when %s", async (_label, reason) => {
    const h = harness();
    await h.watchTasksTool.handler({ task_ids: ["task_1"], reason });

    expect(h.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });
});

describe("watch_tasks — session context", () => {
  it("refuses without a session id, since the waiter can't be named", async () => {
    const h = harness({ agentId: "agent_caller" });
    const result = await h.watchTasksTool.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("validates task_ids before the session precondition", async () => {
    const h = harness({ agentId: "agent_caller" });
    const result = await h.watchTasksTool.handler({ task_ids: [] });

    expect(result.content).toMatchObject({
      message: "task_ids must be a non-empty array of strings",
    });
  });

  it("forwards the caller agent and session from context", async () => {
    const h = harness({ agentId: "agent_x", sessionId: "sess_y" });
    await h.watchTasksTool.handler({ task_ids: ["task_1"] });

    expect(h.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_x",
      callerSessionId: "sess_y",
      taskIds: ["task_1"],
      mode: "all",
      reason: undefined,
    });
  });
});

describe("watch_tasks — success shape", () => {
  it("maps the service result onto the wire contract", async () => {
    const h = harness();
    h.watchTasks.mockResolvedValueOnce({
      watchId: "watch_abc",
      firedImmediately: true,
    });

    const result = await h.watchTasksTool.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "watch_abc",
      fired_immediately: true,
    });
  });

  it("reports fired_immediately false when the watch is still pending", async () => {
    const h = harness();
    const result = await h.watchTasksTool.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "watch_1",
      fired_immediately: false,
    });
  });
});

describe("unwatch", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["a non-string", 12],
  ])("rejects %s watch_id with watch_validation", async (_label, watch_id) => {
    const h = harness();
    const result = await h.unwatchTool.handler({ watch_id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(h.unwatch).not.toHaveBeenCalled();
  });

  it("delegates to the service with the caller agent and returns ok", async () => {
    const h = harness({ agentId: "agent_x", sessionId: "sess_y" });
    const result = await h.unwatchTool.handler({ watch_id: "watch_abc" });

    expect(h.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_x",
      watchId: "watch_abc",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("does not need a session context", async () => {
    const h = harness({ agentId: "agent_x" });
    const result = await h.unwatchTool.handler({ watch_id: "watch_abc" });

    expect(result.content).toEqual({ ok: true });
  });
});

describe("WatchService error mapping", () => {
  const cases: Array<[string, unknown, string, string]> = [
    [
      "WatchAuthError",
      new WatchAuthError("task task_1 is not in your chain"),
      "watch_auth",
      "task task_1 is not in your chain",
    ],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must be unique"),
      "watch_validation",
      "task_ids must be unique",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("watch_zz"),
      "watch_not_found",
      "task_watch watch_zz not found",
    ],
    [
      "a plain Error",
      new Error("connection terminated"),
      "watch_error",
      "connection terminated",
    ],
    ["a thrown string", "pool drained", "watch_error", "pool drained"],
  ];

  it.each(cases)(
    "watch_tasks maps %s to %s",
    async (_label, thrown, code, message) => {
      const h = harness(
        { agentId: "agent_caller", sessionId: "sess_caller" },
        { watchThrows: thrown },
      );
      const result = await h.watchTasksTool.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message });
    },
  );

  it.each(cases)(
    "unwatch maps %s to %s",
    async (_label, thrown, code, message) => {
      const h = harness(
        { agentId: "agent_caller", sessionId: "sess_caller" },
        { unwatchThrows: thrown },
      );
      const result = await h.unwatchTool.handler({ watch_id: "watch_abc" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message });
    },
  );

  it("stringifies a thrown non-Error object", async () => {
    const h = harness(
      { agentId: "agent_caller", sessionId: "sess_caller" },
      { watchThrows: { code: "40001" } },
    );
    const result = await h.watchTasksTool.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      error: "watch_error",
      message: "[object Object]",
    });
  });
});
