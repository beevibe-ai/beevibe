/**
 * watch_tasks + unwatch MCP tools — unit tests with vitest fakes (no DB).
 *
 * Both tools are thin adapters: they coerce the loose MCP input bag into
 * the WatchService call shape, and map the service's three typed errors
 * onto stable tool-error codes. That coercion + mapping is the whole
 * contract this suite pins, so WatchService is a `vi.fn()` pair rather
 * than a real instance — the service's own behaviour (the already-
 * terminal race, the unwatch state machine) is covered by
 * `watch-service.test.ts` against a real DB.
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

const AGENT = "agent_team";
const SESSION = "sess_caller";

function fakeService(overrides: Partial<Record<"watchTasks" | "unwatch", unknown>> = {}) {
  const watchTasks = vi.fn(async (_input: WatchTasksInput) => ({
    watchId: "watch_1",
    firedImmediately: false,
  }));
  const unwatch = vi.fn(async (_input: UnwatchInput) => undefined);
  const watchService = {
    watchTasks,
    unwatch,
    ...overrides,
  } as unknown as WatchService;
  return { watchService, watchTasks, unwatch };
}

function tools(
  ctx: Partial<WatchToolContext> = {},
  overrides: Partial<Record<"watchTasks" | "unwatch", unknown>> = {},
) {
  const svc = fakeService(overrides);
  const [watchTasksTool, unwatchTool] = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...ctx },
    { watchService: svc.watchService },
  );
  return { ...svc, watchTasksTool: watchTasksTool!, unwatchTool: unwatchTool! };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const [a, b] = buildWatchTools(
      { agentId: AGENT, sessionId: SESSION },
      { watchService: fakeService().watchService },
    );
    expect([a?.name, b?.name]).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both fire modes in the watch_tasks schema enum", () => {
    const { watchTasksTool } = tools();
    const props = watchTasksTool.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watchTasksTool.schema.required).toEqual(["task_ids"]);
  });

  it("requires watch_id on the unwatch schema", () => {
    const { unwatchTool } = tools();
    expect(unwatchTool.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks handler", () => {
  it("passes caller agent + session through and defaults mode to 'all'", async () => {
    const { watchTasksTool, watchTasks } = tools();

    const res = await watchTasksTool.handler({ task_ids: ["task_1", "task_2"] });

    expect(watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "watch_1", fired_immediately: false });
  });

  it("honours an explicit 'any' mode", async () => {
    const { watchTasksTool, watchTasks } = tools();
    await watchTasksTool.handler({ task_ids: ["task_1"], mode: "any" });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "any" });
  });

  it("falls back to 'all' when mode isn't a known fire mode", async () => {
    const { watchTasksTool, watchTasks } = tools();
    await watchTasksTool.handler({ task_ids: ["task_1"], mode: "eventually" });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("trims a reason and drops a blank one", async () => {
    const { watchTasksTool, watchTasks } = tools();

    await watchTasksTool.handler({ task_ids: ["t"], reason: "  need the diff  " });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ reason: "need the diff" });

    await watchTasksTool.handler({ task_ids: ["t"], reason: "   " });
    expect(watchTasks.mock.calls[1]?.[0]).toMatchObject({ reason: undefined });

    await watchTasksTool.handler({ task_ids: ["t"], reason: 42 });
    expect(watchTasks.mock.calls[2]?.[0]).toMatchObject({ reason: undefined });
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watchTasksTool, watchTasks } = tools();
    await watchTasksTool.handler({ task_ids: ["task_1", 7, null, "task_2"] });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["task_1", "task_2"],
    });
  });

  it("surfaces fired_immediately from the already-terminal race", async () => {
    const { watchTasksTool } = tools(
      {},
      { watchTasks: vi.fn(async () => ({ watchId: "watch_9", firedImmediately: true })) },
    );
    const res = await watchTasksTool.handler({ task_ids: ["task_1"] });
    expect(res.content).toEqual({ watch_id: "watch_9", fired_immediately: true });
  });

  it("rejects a missing, empty, or all-non-string task_ids without calling the service", async () => {
    for (const task_ids of [undefined, [], "task_1", [1, 2]]) {
      const { watchTasksTool, watchTasks } = tools();
      const res = await watchTasksTool.handler(
        task_ids === undefined ? {} : { task_ids },
      );
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
      expect(res.content.message).toContain("non-empty array");
      expect(watchTasks).not.toHaveBeenCalled();
    }
  });

  it("rejects a call made outside a session context", async () => {
    const { watchTasksTool, watchTasks } = tools({ sessionId: undefined });
    const res = await watchTasksTool.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(res.content.message).toContain("session context");
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it.each([
    [new WatchAuthError("not yours"), "watch_auth"],
    [new WatchValidationError("bad ids"), "watch_validation"],
    [new WatchNotFoundError("watch_x"), "watch_not_found"],
    [new Error("pg down"), "watch_error"],
  ])("maps %s onto the %s tool-error code", async (thrown, code) => {
    const { watchTasksTool } = tools(
      {},
      {
        watchTasks: vi.fn(async () => {
          throw thrown;
        }),
      },
    );
    const res = await watchTasksTool.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe((thrown as Error).message);
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    const { watchTasksTool } = tools(
      {},
      {
        watchTasks: vi.fn(async () => {
          throw "boom";
        }),
      },
    );
    const res = await watchTasksTool.handler({ task_ids: ["task_1"] });
    expect(res.content).toMatchObject({ error: "watch_error", message: "boom" });
  });
});

describe("unwatch handler", () => {
  it("cancels the watch scoped to the caller agent", async () => {
    const { unwatchTool, unwatch } = tools();
    const res = await unwatchTool.handler({ watch_id: "watch_1" });
    expect(unwatch).toHaveBeenCalledWith({ callerAgentId: AGENT, watchId: "watch_1" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    for (const input of [{}, { watch_id: "" }, { watch_id: 1 }]) {
      const { unwatchTool, unwatch } = tools();
      const res = await unwatchTool.handler(input as Record<string, unknown>);
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: "watch_validation" });
      expect(unwatch).not.toHaveBeenCalled();
    }
  });

  it("maps the service's typed errors the same way watch_tasks does", async () => {
    const { unwatchTool } = tools(
      {},
      {
        unwatch: vi.fn(async () => {
          throw new WatchNotFoundError("watch_gone");
        }),
      },
    );
    const res = await unwatchTool.handler({ watch_id: "watch_gone" });
    expect(res.content).toMatchObject({ error: "watch_not_found" });
  });

  it("wraps an unexpected throw as watch_error", async () => {
    const { unwatchTool } = tools(
      {},
      {
        unwatch: vi.fn(async () => {
          throw new Error("connection reset");
        }),
      },
    );
    const res = await unwatchTool.handler({ watch_id: "watch_1" });
    expect(res.content).toMatchObject({
      error: "watch_error",
      message: "connection reset",
    });
  });
});
