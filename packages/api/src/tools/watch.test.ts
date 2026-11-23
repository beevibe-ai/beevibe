/**
 * buildWatchTools — the watch_tasks + unwatch MCP adapters.
 *
 * Both handlers are thin: they normalize raw MCP input, refuse what
 * WatchService would reject anyway, and map the service's typed errors
 * onto the tool error envelope. That normalization + mapping is what
 * these tests pin; WatchService's own behaviour (the auth check, the
 * terminal-race fire, the unwatch state machine) is covered by
 * core/src/services/watch-service.test.ts against a real pool.
 */

import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
  type UnwatchInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

interface Harness {
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  watchTasksTool: AgentTool;
  unwatchTool: AgentTool;
}

function harness(
  opts: {
    ctx?: Partial<WatchToolContext>;
    watchTasksImpl?: (input: WatchTasksInput) => Promise<unknown>;
    unwatchImpl?: (input: UnwatchInput) => Promise<unknown>;
  } = {},
): Harness {
  const watchTasks = vi.fn(
    opts.watchTasksImpl ??
      (async () => ({ watchId: "tw_1", firedImmediately: false })),
  );
  const unwatch = vi.fn(opts.unwatchImpl ?? (async () => undefined));
  const watchService = { watchTasks, unwatch } as unknown as WatchService;

  const tools = buildWatchTools(
    { agentId: "agent_a", sessionId: "sess_1", ...opts.ctx },
    { watchService },
  );
  const watchTasksTool = tools.find((t) => t.name === "watch_tasks")!;
  const unwatchTool = tools.find((t) => t.name === "unwatch")!;
  return { watchTasks, unwatch, watchTasksTool, unwatchTool };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watchTasksTool, unwatchTool } = harness();
    expect(watchTasksTool).toBeDefined();
    expect(unwatchTool).toBeDefined();
    expect(watchTasksTool.schema.required).toEqual(["task_ids"]);
    expect(unwatchTool.schema.required).toEqual(["watch_id"]);
  });

  it("advertises every supported mode in the watch_tasks schema", () => {
    const { watchTasksTool } = harness();
    const props = watchTasksTool.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(expect.arrayContaining(["all", "any"]));
  });
});

describe("watch_tasks handler", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const { watchTasks, watchTasksTool } = harness();

    const result = await watchTasksTool.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first signal  ",
    });

    expect(watchTasks).toHaveBeenCalledTimes(1);
    expect(watchTasks.mock.calls[0]?.[0]).toEqual({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      // trimmed, not passed through raw
      reason: "need the first signal",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "tw_1",
      fired_immediately: false,
    });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const { watchTasks, watchTasksTool } = harness();

    await watchTasksTool.handler({ task_ids: ["task_1"] });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });

    await watchTasksTool.handler({ task_ids: ["task_1"], mode: "sideways" });
    expect(watchTasks.mock.calls[1]?.[0]).toMatchObject({ mode: "all" });

    await watchTasksTool.handler({ task_ids: ["task_1"], mode: 7 });
    expect(watchTasks.mock.calls[2]?.[0]).toMatchObject({ mode: "all" });
  });

  it("omits reason entirely when blank, rather than sending an empty string", async () => {
    const { watchTasks, watchTasksTool } = harness();

    await watchTasksTool.handler({ task_ids: ["task_1"], reason: "   " });
    expect(watchTasks.mock.calls[0]?.[0].reason).toBeUndefined();

    await watchTasksTool.handler({ task_ids: ["task_1"], reason: 42 });
    expect(watchTasks.mock.calls[1]?.[0].reason).toBeUndefined();
  });

  it("drops non-string entries from task_ids", async () => {
    const { watchTasks, watchTasksTool } = harness();

    await watchTasksTool.handler({
      task_ids: ["task_1", 2, null, "task_3", { id: "task_4" }],
    });

    expect(watchTasks.mock.calls[0]?.[0].taskIds).toEqual([
      "task_1",
      "task_3",
    ]);
  });

  it("reports fired_immediately straight from the service result", async () => {
    const { watchTasksTool } = harness({
      watchTasksImpl: async () => ({
        watchId: "tw_hot",
        firedImmediately: true,
      }),
    });

    const result = await watchTasksTool.handler({ task_ids: ["task_done"] });

    expect(result.content).toEqual({
      watch_id: "tw_hot",
      fired_immediately: true,
    });
  });

  describe("input the handler refuses before reaching the service", () => {
    it("rejects a missing task_ids array", async () => {
      const { watchTasks, watchTasksTool } = harness();
      const result = await watchTasksTool.handler({});

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(watchTasks).not.toHaveBeenCalled();
    });

    it("rejects task_ids that is not an array", async () => {
      const { watchTasks, watchTasksTool } = harness();
      const result = await watchTasksTool.handler({ task_ids: "task_1" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(watchTasks).not.toHaveBeenCalled();
    });

    it("rejects an array that holds no usable string ids", async () => {
      const { watchTasks, watchTasksTool } = harness();
      const result = await watchTasksTool.handler({ task_ids: [1, 2, null] });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(watchTasks).not.toHaveBeenCalled();
    });

    it("rejects the call when there is no session context to wake", async () => {
      const { watchTasks, watchTasksTool } = harness({
        ctx: { sessionId: undefined },
      });

      const result = await watchTasksTool.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "watch_validation",
        message: expect.stringContaining("session context"),
      });
      expect(watchTasks).not.toHaveBeenCalled();
    });
  });
});

describe("unwatch handler", () => {
  it("forwards the caller agent and watch id", async () => {
    const { unwatch, unwatchTool } = harness();

    const result = await unwatchTool.handler({ watch_id: "tw_1" });

    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(unwatch.mock.calls[0]?.[0]).toEqual({
      callerAgentId: "agent_a",
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    const { unwatch, unwatchTool } = harness();

    for (const input of [{}, { watch_id: "" }, { watch_id: 5 }]) {
      const result = await unwatchTool.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(unwatch).not.toHaveBeenCalled();
  });
});

describe("service error mapping (shared by both handlers)", () => {
  const cases: Array<{
    label: string;
    thrown: unknown;
    code: string;
    message?: string;
  }> = [
    {
      label: "WatchAuthError",
      thrown: new WatchAuthError("task task_x is not in your chain"),
      code: "watch_auth",
      message: "task task_x is not in your chain",
    },
    {
      label: "WatchValidationError",
      thrown: new WatchValidationError("task_ids must be non-empty"),
      code: "watch_validation",
      message: "task_ids must be non-empty",
    },
    {
      label: "WatchNotFoundError",
      thrown: new WatchNotFoundError("tw_missing"),
      code: "watch_not_found",
      message: "task_watch tw_missing not found",
    },
    {
      label: "a plain Error",
      thrown: new Error("pool exploded"),
      code: "watch_error",
      message: "pool exploded",
    },
  ];

  for (const { label, thrown, code, message } of cases) {
    it(`maps ${label} thrown by watchTasks to ${code}`, async () => {
      const { watchTasksTool } = harness({
        watchTasksImpl: async () => {
          throw thrown;
        },
      });

      const result = await watchTasksTool.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code, message });
    });

    it(`maps ${label} thrown by unwatch to ${code}`, async () => {
      const { unwatchTool } = harness({
        unwatchImpl: async () => {
          throw thrown;
        },
      });

      const result = await unwatchTool.handler({ watch_id: "tw_1" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code, message });
    });
  }

  it("stringifies a non-Error throw rather than losing it", async () => {
    const { watchTasksTool } = harness({
      watchTasksImpl: async () => {
        throw "just a string";
      },
    });

    const result = await watchTasksTool.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "just a string",
    });
  });
});
