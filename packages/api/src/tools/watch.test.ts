/**
 * Tests for the watch_tasks + unwatch MCP tools.
 *
 * Both are thin adapters over WatchService, so the surface that
 * belongs here is the adapter's own work: coercing loosely-typed MCP
 * input into a valid service call, rejecting what the service should
 * never see, and translating the service's four throw shapes into the
 * coded tool-error envelope agents branch on. Anything past that (the
 * auth check, the already-terminal race, the unwatch state machine) is
 * WatchService's contract and is tested there.
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

function fakeWatchService(overrides: Partial<WatchService> = {}): WatchService {
  return {
    watchTasks: vi.fn(async () => ({
      watchId: "twh_1",
      firedImmediately: false,
    })),
    unwatch: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WatchService;
}

function build(
  ctx: { agentId: string; sessionId?: string },
  watchService: WatchService,
): { watchTasks: AgentTool; unwatch: AgentTool } {
  const [watchTasks, unwatch] = buildWatchTools(ctx, { watchService });
  return { watchTasks: watchTasks!, unwatch: unwatch! };
}

const CTX = { agentId: "agt_team", sessionId: "sess_1" };

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const tools = buildWatchTools(CTX, { watchService: fakeWatchService() });
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the mode enum and required fields in the schemas", () => {
    const { watchTasks, unwatch } = build(CTX, fakeWatchService());
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    const props = watchTasks.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks handler", () => {
  it("forwards caller identity, ids, mode and reason to the service", async () => {
    const svc = fakeWatchService();
    const { watchTasks } = build(CTX, svc);

    const result = await watchTasks.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(svc.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agt_team",
      callerSessionId: "sess_1",
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "twh_1",
      fired_immediately: false,
    });
  });

  it("defaults the mode to 'all' when omitted or unrecognized", async () => {
    const svc = fakeWatchService();
    const { watchTasks } = build(CTX, svc);

    await watchTasks.handler({ task_ids: ["task_a"] });
    await watchTasks.handler({ task_ids: ["task_a"], mode: "eventually" });
    await watchTasks.handler({ task_ids: ["task_a"], mode: 7 });

    const modes = vi
      .mocked(svc.watchTasks)
      .mock.calls.map(([input]) => input.mode);
    expect(modes).toEqual(["all", "all", "all"]);
  });

  it("drops a whitespace-only reason rather than sending it through", async () => {
    const svc = fakeWatchService();
    const { watchTasks } = build(CTX, svc);

    await watchTasks.handler({ task_ids: ["task_a"], reason: "   " });
    await watchTasks.handler({ task_ids: ["task_a"], reason: 42 });

    const reasons = vi
      .mocked(svc.watchTasks)
      .mock.calls.map(([input]) => input.reason);
    expect(reasons).toEqual([undefined, undefined]);
  });

  it("filters non-string entries out of task_ids", async () => {
    const svc = fakeWatchService();
    const { watchTasks } = build(CTX, svc);

    await watchTasks.handler({ task_ids: ["task_a", 3, null, "task_b"] });

    expect(vi.mocked(svc.watchTasks).mock.calls[0]?.[0].taskIds).toEqual([
      "task_a",
      "task_b",
    ]);
  });

  it("rejects a missing, non-array, or all-invalid task_ids without calling the service", async () => {
    const svc = fakeWatchService();
    const { watchTasks } = build(CTX, svc);

    for (const input of [{}, { task_ids: "task_a" }, { task_ids: [] }, { task_ids: [1, 2] }]) {
      const result = await watchTasks.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(svc.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects the call when there is no session context", async () => {
    const svc = fakeWatchService();
    const { watchTasks } = build({ agentId: "agt_team" }, svc);

    const result = await watchTasks.handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: expect.stringContaining("session context"),
    });
    expect(svc.watchTasks).not.toHaveBeenCalled();
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const svc = fakeWatchService({
      watchTasks: vi.fn(async () => ({ watchId: "twh_9", firedImmediately: true })),
    } as Partial<WatchService>);
    const { watchTasks } = build(CTX, svc);

    const result = await watchTasks.handler({ task_ids: ["task_done"] });

    expect(result.content).toEqual({
      watch_id: "twh_9",
      fired_immediately: true,
    });
  });

  it.each([
    [new WatchAuthError("not your task"), "watch_auth", "not your task"],
    [
      new WatchValidationError("mode must be all|any"),
      "watch_validation",
      "mode must be all|any",
    ],
    [new WatchNotFoundError("twh_x"), "watch_not_found", "task_watch twh_x not found"],
    [new Error("pool exhausted"), "watch_error", "pool exhausted"],
  ])("maps %s to a coded tool error", async (thrown, code, message) => {
    const svc = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw thrown;
      }),
    } as Partial<WatchService>);
    const { watchTasks } = build(CTX, svc);

    const result = await watchTasks.handler({ task_ids: ["task_a"] });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message });
  });

  it("stringifies a non-Error throw", async () => {
    const svc = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw "kaboom";
      }),
    } as Partial<WatchService>);
    const { watchTasks } = build(CTX, svc);

    const result = await watchTasks.handler({ task_ids: ["task_a"] });

    expect(result.content).toEqual({ error: "watch_error", message: "kaboom" });
  });
});

describe("unwatch handler", () => {
  it("forwards the caller agent + watch id and reports ok", async () => {
    const svc = fakeWatchService();
    const { unwatch } = build(CTX, svc);

    const result = await unwatch.handler({ watch_id: "twh_1" });

    expect(svc.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agt_team",
      watchId: "twh_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    const svc = fakeWatchService();
    const { unwatch } = build(CTX, svc);

    for (const input of [{}, { watch_id: "" }, { watch_id: 12 }]) {
      const result = await unwatch.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(svc.unwatch).not.toHaveBeenCalled();
  });

  it("maps a service throw through the same coded envelope", async () => {
    const svc = fakeWatchService({
      unwatch: vi.fn(async () => {
        throw new WatchAuthError("not yours");
      }),
    } as Partial<WatchService>);
    const { unwatch } = build(CTX, svc);

    const result = await unwatch.handler({ watch_id: "twh_1" });

    expect(result.content).toEqual({ error: "watch_auth", message: "not yours" });
  });
});
