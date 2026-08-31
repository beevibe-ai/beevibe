/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService: the service owns the
 * auth check, the insert and the already-terminal race. What lives
 * *here* is the input coercion (task_ids filtering, mode defaulting,
 * reason trimming), the session-context guard, and the error-class ->
 * error-code mapping. Those are the paths this file pins, with a stub
 * service standing in for the DB-backed real one.
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
import type { AgentTool } from "./types.js";

const ctx: WatchToolContext = { agentId: "agent_1", sessionId: "ses_1" };

/** A WatchService stub whose two methods are vi.fn()s the test drives. */
function stubService(overrides: Partial<Record<"watchTasks" | "unwatch", unknown>> = {}) {
  const watchTasks = vi.fn(async (_input: WatchTasksInput) => ({
    watchId: "twt_1",
    firedImmediately: false,
  }));
  const unwatch = vi.fn(async (_input: UnwatchInput) => undefined);
  const service = {
    watchTasks: overrides.watchTasks ?? watchTasks,
    unwatch: overrides.unwatch ?? unwatch,
  } as unknown as WatchService;
  return { service, watchTasks, unwatch };
}

function tools(service: WatchService, c: WatchToolContext = ctx) {
  const built = buildWatchTools(c, { watchService: service });
  const byName = (name: string): AgentTool => {
    const tool = built.find((t) => t.name === name);
    if (!tool) throw new Error(`buildWatchTools did not return ${name}`);
    return tool;
  };
  return { watchTasks: byName("watch_tasks"), unwatch: byName("unwatch") };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { service } = stubService();
    const built = buildWatchTools(ctx, { watchService: service });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares task_ids required and both modes on watch_tasks", () => {
    const { service } = stubService();
    const { watchTasks } = tools(service);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    const props = watchTasks.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode!.enum).toEqual(["all", "any"]);
  });
});

describe("watch_tasks handler", () => {
  it("passes caller identity, ids and mode through to the service", async () => {
    const { service, watchTasks: spy } = stubService();
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler({
      task_ids: ["tsk_a", "tsk_b"],
      mode: "any",
      reason: "need both results",
    });

    expect(spy).toHaveBeenCalledWith({
      callerAgentId: "agent_1",
      callerSessionId: "ses_1",
      taskIds: ["tsk_a", "tsk_b"],
      mode: "any",
      reason: "need both results",
    });
    expect(res).toEqual({
      content: { watch_id: "twt_1", fired_immediately: false },
    });
  });

  it("surfaces fired_immediately from the already-terminal path", async () => {
    const { service } = stubService({
      watchTasks: vi.fn(async () => ({
        watchId: "twt_9",
        firedImmediately: true,
      })),
    });
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler({ task_ids: ["tsk_a"] });
    expect(res.content).toEqual({ watch_id: "twt_9", fired_immediately: true });
  });

  // "all" is the conservative default: waiting for every task can only
  // delay the wake-up, where defaulting to "any" could fire before the
  // results the agent asked for exist.
  it("defaults mode to 'all' when omitted or not a valid mode", async () => {
    const { service, watchTasks: spy } = stubService();
    const { watchTasks } = tools(service);

    await watchTasks.handler({ task_ids: ["tsk_a"] });
    await watchTasks.handler({ task_ids: ["tsk_a"], mode: "eventually" });
    await watchTasks.handler({ task_ids: ["tsk_a"], mode: 7 });

    for (const call of spy.mock.calls) {
      expect(call[0].mode).toBe("all");
    }
  });

  it("drops non-string entries from task_ids rather than forwarding them", async () => {
    const { service, watchTasks: spy } = stubService();
    const { watchTasks } = tools(service);

    await watchTasks.handler({ task_ids: ["tsk_a", 42, null, "tsk_b", {}] });

    expect(spy.mock.calls[0]![0].taskIds).toEqual(["tsk_a", "tsk_b"]);
  });

  it("trims reason, and omits it when blank or non-string", async () => {
    const { service, watchTasks: spy } = stubService();
    const { watchTasks } = tools(service);

    await watchTasks.handler({ task_ids: ["tsk_a"], reason: "  tidy  " });
    await watchTasks.handler({ task_ids: ["tsk_a"], reason: "   " });
    await watchTasks.handler({ task_ids: ["tsk_a"], reason: 12 });

    const reasons = spy.mock.calls.map((c) => c[0].reason);
    expect(reasons).toEqual(["tidy", undefined, undefined]);
  });

  it.each([
    ["missing", {}],
    ["empty array", { task_ids: [] }],
    ["all non-strings", { task_ids: [1, 2] }],
    ["not an array", { task_ids: "tsk_a" }],
  ])("rejects %s task_ids without calling the service", async (_label, input) => {
    const { service, watchTasks: spy } = stubService();
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler(input as Record<string, unknown>);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(spy).not.toHaveBeenCalled();
  });

  // Without a session id the service cannot identify the waiter, so the
  // guard has to fire before the call, not surface as a service error.
  it("refuses to register a watch outside a session context", async () => {
    const { service, watchTasks: spy } = stubService();
    const { watchTasks } = tools(service, { agentId: "agent_1" });

    const res = await watchTasks.handler({ task_ids: ["tsk_a"] });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("unwatch handler", () => {
  it("forwards the watch id and reports ok", async () => {
    const { service, unwatch: spy } = stubService();
    const { unwatch } = tools(service);

    const res = await unwatch.handler({ watch_id: "twt_1" });

    expect(spy).toHaveBeenCalledWith({
      callerAgentId: "agent_1",
      watchId: "twt_1",
    });
    expect(res).toEqual({ content: { ok: true } });
  });

  it.each([
    ["missing", {}],
    ["empty", { watch_id: "" }],
    ["non-string", { watch_id: 5 }],
  ])("rejects a %s watch_id without calling the service", async (_l, input) => {
    const { service, unwatch: spy } = stubService();
    const { unwatch } = tools(service);

    const res = await unwatch.handler(input as Record<string, unknown>);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(spy).not.toHaveBeenCalled();
  });
});

// The agent branches on `error`, so each service failure class has to
// keep its own stable code — collapsing them all to "watch_error" would
// make an auth denial indistinguishable from a bad id.
describe("service error mapping", () => {
  it.each([
    ["watch_auth", new WatchAuthError("not your task")],
    ["watch_validation", new WatchValidationError("mode is bogus")],
    ["watch_not_found", new WatchNotFoundError("twt_missing")],
    ["watch_error", new Error("connection reset")],
  ])("maps a thrown %s onto its code", async (code, thrown) => {
    const { service } = stubService({
      watchTasks: vi.fn(async () => {
        throw thrown;
      }),
    });
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler({ task_ids: ["tsk_a"] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe(thrown.message);
  });

  it("stringifies a non-Error throw under the catch-all code", async () => {
    const { service } = stubService({
      watchTasks: vi.fn(async () => {
        throw "pool exhausted";
      }),
    });
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler({ task_ids: ["tsk_a"] });

    expect(res.content).toEqual({
      error: "watch_error",
      message: "pool exhausted",
    });
  });

  it("maps errors thrown out of unwatch through the same table", async () => {
    const { service } = stubService({
      unwatch: vi.fn(async () => {
        throw new WatchNotFoundError("twt_gone");
      }),
    });
    const { unwatch } = tools(service);

    const res = await unwatch.handler({ watch_id: "twt_gone" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_not_found");
  });
});
