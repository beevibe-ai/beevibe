/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService — the interesting
 * surface is what the adapter does *before* delegating (input coercion,
 * mode defaulting, the missing-session guard) and how it maps the
 * service's typed errors onto stable `error` codes the agent branches
 * on. Service behavior itself is covered by watch-service's own suite.
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
  tools: AgentTool[];
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: {
    ctx?: Partial<WatchToolContext>;
    watchTasks?: () => Promise<unknown>;
    unwatch?: () => Promise<unknown>;
  } = {},
): Harness {
  const watchTasks = vi.fn(
    overrides.watchTasks ??
      (async () => ({ watchId: "tw_1", firedImmediately: false })),
  );
  const unwatch = vi.fn(overrides.unwatch ?? (async () => undefined));
  const watchService = { watchTasks, unwatch } as unknown as WatchService;

  const ctx: WatchToolContext = {
    agentId: "agent_caller",
    sessionId: "ses_caller",
    ...overrides.ctx,
  };

  return { tools: buildWatchTools(ctx, { watchService }), watchTasks, unwatch };
}

function watchTasksTool(h: Harness): AgentTool {
  const t = h.tools.find((x) => x.name === "watch_tasks");
  if (!t) throw new Error("watch_tasks tool missing");
  return t;
}

function unwatchTool(h: Harness): AgentTool {
  const t = h.tools.find((x) => x.name === "unwatch");
  if (!t) throw new Error("unwatch tool missing");
  return t;
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch in that order", () => {
    expect(harness().tools.map((t) => t.name)).toEqual([
      "watch_tasks",
      "unwatch",
    ]);
  });

  it("advertises both watch modes in the schema enum", () => {
    const schema = watchTasksTool(harness()).schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, ids, mode and reason to the service", async () => {
    const h = harness();
    const result = await watchTasksTool(h).handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(h.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_caller",
      callerSessionId: "ses_caller",
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "tw_1",
      fired_immediately: false,
    });
  });

  it("surfaces firedImmediately from the already-terminal race path", async () => {
    const h = harness({
      watchTasks: async () => ({ watchId: "tw_2", firedImmediately: true }),
    });
    const result = await watchTasksTool(h).handler({ task_ids: ["task_a"] });

    expect(result.content).toEqual({
      watch_id: "tw_2",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_a"] });

    expect(h.watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it.each([
    ["an unknown string", "first"],
    ["a non-string", 1],
    ["null", null],
  ])("defaults mode to 'all' for %s", async (_label, mode) => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_a"], mode });

    expect(h.watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it.each([
    ["whitespace-only", "   "],
    ["empty", ""],
    ["a non-string", 7],
  ])("drops %s reason instead of forwarding it", async (_label, reason) => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_a"], reason });

    expect(h.watchTasks.mock.calls[0]?.[0]).toMatchObject({
      reason: undefined,
    });
  });

  it("filters non-string entries out of task_ids", async () => {
    const h = harness();
    await watchTasksTool(h).handler({
      task_ids: ["task_a", 42, null, "task_b"],
    });

    expect(h.watchTasks.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["task_a", "task_b"],
    });
  });

  it.each([
    ["an empty array", []],
    ["an array with no strings left", [1, null]],
    ["a non-array", "task_a"],
    ["undefined", undefined],
  ])("rejects %s task_ids without calling the service", async (_l, task_ids) => {
    const h = harness();
    const result = await watchTasksTool(h).handler({ task_ids });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch outside a session context", async () => {
    const h = harness({ ctx: { sessionId: undefined } });
    const result = await watchTasksTool(h).handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });
});

describe("unwatch", () => {
  it("delegates to the service and reports ok", async () => {
    const h = harness();
    const result = await unwatchTool(h).handler({ watch_id: "tw_1" });

    expect(h.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_caller",
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 5],
    ["undefined", undefined],
  ])("rejects %s watch_id without calling the service", async (_l, watch_id) => {
    const h = harness();
    const result = await unwatchTool(h).handler({ watch_id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.unwatch).not.toHaveBeenCalled();
  });

  it("still reports ok when the watch is already gone (idempotent)", async () => {
    const h = harness({ unwatch: async () => undefined });
    const result = await unwatchTool(h).handler({ watch_id: "tw_gone" });

    expect(result.content).toEqual({ ok: true });
  });
});

describe("service error mapping", () => {
  const cases: Array<[string, unknown, string, string]> = [
    [
      "WatchAuthError",
      new WatchAuthError("task task_a is not in your chain"),
      "watch_auth",
      "task task_a is not in your chain",
    ],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
      "task_ids must be non-empty",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("tw_missing"),
      "watch_not_found",
      "task_watch tw_missing not found",
    ],
    [
      "a plain Error",
      new Error("connection terminated"),
      "watch_error",
      "connection terminated",
    ],
    ["a thrown string", "boom", "watch_error", "boom"],
  ];

  it.each(cases)(
    "maps %s out of watch_tasks",
    async (_label, thrown, code, message) => {
      const h = harness({
        watchTasks: async () => {
          throw thrown;
        },
      });
      const result = await watchTasksTool(h).handler({ task_ids: ["task_a"] });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message });
    },
  );

  it.each(cases)(
    "maps %s out of unwatch",
    async (_label, thrown, code, message) => {
      const h = harness({
        unwatch: async () => {
          throw thrown;
        },
      });
      const result = await unwatchTool(h).handler({ watch_id: "tw_1" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message });
    },
  );
});
