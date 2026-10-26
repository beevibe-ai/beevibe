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
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  watch: AgentTool;
  unwatchTool: AgentTool;
}

function harness(ctx: Partial<WatchToolContext> = {}): Harness {
  const watchTasks = vi.fn(async () => ({
    watchId: "watch_1",
    firedImmediately: false,
  }));
  const unwatch = vi.fn(async () => undefined);
  const watchService = { watchTasks, unwatch } as unknown as WatchService;
  const tools = buildWatchTools(
    { agentId: "agent_team", sessionId: "sess_1", ...ctx },
    { watchService },
  );
  const watch = tools.find((t) => t.name === "watch_tasks");
  const unwatchTool = tools.find((t) => t.name === "unwatch");
  if (!watch || !unwatchTool) throw new Error("expected both watch tools");
  return { watchTasks, unwatch, watch, unwatchTool };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watch, unwatchTool } = harness();
    expect(watch.name).toBe("watch_tasks");
    expect(unwatchTool.name).toBe("unwatch");
  });

  it("declares task_ids required and both modes in the enum", () => {
    const { watch } = harness();
    expect(watch.schema.required).toEqual(["task_ids"]);
    const props = watch.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(["all", "any"]);
  });

  it("declares watch_id required on unwatch", () => {
    const { unwatchTool } = harness();
    expect(unwatchTool.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks handler", () => {
  it("forwards caller identity, task ids and mode to the service", async () => {
    const { watch, watchTasks } = harness();

    const result = await watch.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });

    expect(watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_team",
      callerSessionId: "sess_1",
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "watch_1",
      fired_immediately: false,
    });
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const { watch, watchTasks } = harness();
    watchTasks.mockResolvedValueOnce({
      watchId: "watch_hot",
      firedImmediately: true,
    });

    const result = await watch.handler({ task_ids: ["task_done"] });

    expect(result.content).toEqual({
      watch_id: "watch_hot",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const { watch, watchTasks } = harness();
    await watch.handler({ task_ids: ["task_a"] });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("defaults mode to 'all' when the value is not a known mode", async () => {
    const { watch, watchTasks } = harness();
    await watch.handler({ task_ids: ["task_a"], mode: "eventually" });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("defaults mode to 'all' when the value is not a string", async () => {
    const { watch, watchTasks } = harness();
    await watch.handler({ task_ids: ["task_a"], mode: 7 });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("trims reason and drops a blank one", async () => {
    const { watch, watchTasks } = harness();

    await watch.handler({ task_ids: ["task_a"], reason: "  check the build  " });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({
      reason: "check the build",
    });

    await watch.handler({ task_ids: ["task_a"], reason: "   " });
    expect(watchTasks.mock.calls[1]?.[0].reason).toBeUndefined();

    await watch.handler({ task_ids: ["task_a"], reason: 42 });
    expect(watchTasks.mock.calls[2]?.[0].reason).toBeUndefined();
  });

  it("drops non-string entries from task_ids", async () => {
    const { watch, watchTasks } = harness();
    await watch.handler({ task_ids: ["task_a", 7, null, "task_b"] });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["task_a", "task_b"],
    });
  });

  it("rejects an empty task_ids array without calling the service", async () => {
    const { watch, watchTasks } = harness();
    const result = await watch.handler({ task_ids: [] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects task_ids that is not an array", async () => {
    const { watch, watchTasks } = harness();
    const result = await watch.handler({ task_ids: "task_a" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects task_ids whose entries are all non-strings", async () => {
    const { watch, watchTasks } = harness();
    const result = await watch.handler({ task_ids: [1, 2, 3] });
    expect(result.isError).toBe(true);
    expect(watchTasks).not.toHaveBeenCalled();
  });

  // Without a session id there is no waiter to chain the wake session off.
  it("rejects a call made outside a session context", async () => {
    const { watch, watchTasks } = harness({ sessionId: undefined });
    const result = await watch.handler({ task_ids: ["task_a"] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  // Validation order matters: a bad task_ids is reported even when the
  // session context is also missing, so the agent fixes the real problem.
  it("reports the task_ids problem before the missing session", async () => {
    const { watch } = harness({ sessionId: undefined });
    const result = await watch.handler({ task_ids: [] });
    expect(result.content).toMatchObject({
      message: "task_ids must be a non-empty array of strings",
    });
  });
});

describe("watch_tasks error mapping", () => {
  const cases: Array<[string, Error, string]> = [
    ["auth", new WatchAuthError("task not in your chain"), "watch_auth"],
    ["validation", new WatchValidationError("too many tasks"), "watch_validation"],
    ["not found", new WatchNotFoundError("watch_9"), "watch_not_found"],
    ["generic", new Error("pool exhausted"), "watch_error"],
  ];

  for (const [label, err, code] of cases) {
    it(`maps a ${label} error to ${code}`, async () => {
      const { watch, watchTasks } = harness();
      watchTasks.mockRejectedValueOnce(err);
      const result = await watch.handler({ task_ids: ["task_a"] });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code, message: err.message });
    });
  }

  it("stringifies a non-Error throw", async () => {
    const { watch, watchTasks } = harness();
    watchTasks.mockRejectedValueOnce("socket hang up");
    const result = await watch.handler({ task_ids: ["task_a"] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "socket hang up",
    });
  });
});

describe("unwatch handler", () => {
  it("forwards the caller agent and watch id", async () => {
    const { unwatchTool, unwatch } = harness();
    const result = await unwatchTool.handler({ watch_id: "watch_1" });
    expect(unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_team",
      watchId: "watch_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("works without a session context — unwatch only needs the agent", async () => {
    const { unwatchTool, unwatch } = harness({ sessionId: undefined });
    const result = await unwatchTool.handler({ watch_id: "watch_1" });
    expect(result.content).toEqual({ ok: true });
    expect(unwatch).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing or blank watch_id without calling the service", async () => {
    const { unwatchTool, unwatch } = harness();

    for (const input of [{}, { watch_id: "" }, { watch_id: 7 }]) {
      const result = await unwatchTool.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
    }
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("maps a not-found error from the service", async () => {
    const { unwatchTool, unwatch } = harness();
    unwatch.mockRejectedValueOnce(new WatchNotFoundError("watch_gone"));
    const result = await unwatchTool.handler({ watch_id: "watch_gone" });
    expect(result.content).toMatchObject({ error: "watch_not_found" });
  });

  it("maps an auth error from the service", async () => {
    const { unwatchTool, unwatch } = harness();
    unwatch.mockRejectedValueOnce(new WatchAuthError("not your watch"));
    const result = await unwatchTool.handler({ watch_id: "watch_other" });
    expect(result.content).toMatchObject({ error: "watch_auth" });
  });
});
