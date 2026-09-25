import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

interface Stub {
  watchService: WatchService;
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
}

function stubService(overrides: Partial<Stub> = {}): Stub {
  const watchTasks =
    overrides.watchTasks ??
    vi.fn(async () => ({ watchId: "twch_1", firedImmediately: false }));
  const unwatch = overrides.unwatch ?? vi.fn(async () => undefined);
  return {
    watchService: { watchTasks, unwatch } as unknown as WatchService,
    watchTasks,
    unwatch,
  };
}

const CTX: WatchToolContext = { agentId: "agent_team", sessionId: "sess_1" };

function tools(ctx: WatchToolContext, stub: Stub): Record<string, AgentTool> {
  const byName: Record<string, AgentTool> = {};
  for (const t of buildWatchTools(ctx, { watchService: stub.watchService })) {
    byName[t.name] = t;
  }
  return byName;
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const stub = stubService();
    const built = buildWatchTools(CTX, { watchService: stub.watchService });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares task_ids required on watch_tasks and watch_id on unwatch", () => {
    const stub = stubService();
    const byName = tools(CTX, stub);
    expect(byName.watch_tasks?.schema.required).toEqual(["task_ids"]);
    expect(byName.unwatch?.schema.required).toEqual(["watch_id"]);
  });

  it("enumerates the domain's watch modes in the schema", () => {
    const stub = stubService();
    const props = tools(CTX, stub).watch_tasks?.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(expect.arrayContaining(["all", "any"]));
  });
});

describe("watch_tasks handler", () => {
  it("forwards caller ids, task_ids, mode and trimmed reason to WatchService", async () => {
    const stub = stubService();
    const result = await tools(CTX, stub).watch_tasks!.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(stub.watchTasks).toHaveBeenCalledTimes(1);
    expect(stub.watchTasks.mock.calls[0]?.[0]).toEqual({
      callerAgentId: "agent_team",
      callerSessionId: "sess_1",
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "twch_1",
      fired_immediately: false,
    });
  });

  it("defaults mode to 'all' when absent or not a known mode", async () => {
    const stub = stubService();
    const tool = tools(CTX, stub).watch_tasks!;

    await tool.handler({ task_ids: ["task_a"] });
    await tool.handler({ task_ids: ["task_a"], mode: "eventually" });
    await tool.handler({ task_ids: ["task_a"], mode: 7 });

    for (const call of stub.watchTasks.mock.calls) {
      expect((call[0] as { mode: string }).mode).toBe("all");
    }
  });

  it("drops a blank or non-string reason rather than passing it through", async () => {
    const stub = stubService();
    const tool = tools(CTX, stub).watch_tasks!;

    await tool.handler({ task_ids: ["task_a"], reason: "   " });
    await tool.handler({ task_ids: ["task_a"], reason: 42 });

    for (const call of stub.watchTasks.mock.calls) {
      expect((call[0] as { reason?: string }).reason).toBeUndefined();
    }
  });

  it("filters non-string entries out of task_ids", async () => {
    const stub = stubService();
    await tools(CTX, stub).watch_tasks!.handler({
      task_ids: ["task_a", 5, null, "task_b", { id: "task_c" }],
    });
    expect((stub.watchTasks.mock.calls[0]?.[0] as { taskIds: string[] }).taskIds).toEqual([
      "task_a",
      "task_b",
    ]);
  });

  it("reports fired_immediately from the service verbatim", async () => {
    const stub = stubService({
      watchTasks: vi.fn(async () => ({ watchId: "twch_9", firedImmediately: true })),
    });
    const result = await tools(CTX, stub).watch_tasks!.handler({ task_ids: ["task_a"] });
    expect(result.content).toEqual({ watch_id: "twch_9", fired_immediately: true });
  });

  it("rejects an empty, all-non-string, or missing task_ids without calling the service", async () => {
    const stub = stubService();
    const tool = tools(CTX, stub).watch_tasks!;

    for (const input of [{ task_ids: [] }, { task_ids: [1, 2] }, {}, { task_ids: "task_a" }]) {
      const result = await tool.handler(input as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(stub.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a call made outside a session context", async () => {
    const stub = stubService();
    const result = await tools({ agentId: "agent_team" }, stub).watch_tasks!.handler({
      task_ids: ["task_a"],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: expect.stringContaining("session context"),
    });
    expect(stub.watchTasks).not.toHaveBeenCalled();
  });

  it.each([
    [new WatchAuthError("not your task"), "watch_auth", "not your task"],
    [new WatchValidationError("bad mode"), "watch_validation", "bad mode"],
    [new WatchNotFoundError("twch_x"), "watch_not_found", "task_watch twch_x not found"],
    [new Error("pool exhausted"), "watch_error", "pool exhausted"],
  ])("maps %s thrown by the service onto its error code", async (thrown, code, message) => {
    const stub = stubService({
      watchTasks: vi.fn(async () => {
        throw thrown;
      }),
    });
    const result = await tools(CTX, stub).watch_tasks!.handler({ task_ids: ["task_a"] });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message });
  });

  it("stringifies a non-Error throw under the generic watch_error code", async () => {
    const stub = stubService({
      watchTasks: vi.fn(async () => {
        throw "raw string failure";
      }),
    });
    const result = await tools(CTX, stub).watch_tasks!.handler({ task_ids: ["task_a"] });
    expect(result.content).toEqual({
      error: "watch_error",
      message: "raw string failure",
    });
  });
});

describe("unwatch handler", () => {
  it("forwards the caller agent id and watch id, and reports ok", async () => {
    const stub = stubService();
    const result = await tools(CTX, stub).unwatch!.handler({ watch_id: "twch_1" });

    expect(stub.unwatch).toHaveBeenCalledTimes(1);
    expect(stub.unwatch.mock.calls[0]?.[0]).toEqual({
      callerAgentId: "agent_team",
      watchId: "twch_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing, empty, or non-string watch_id without calling the service", async () => {
    const stub = stubService();
    const tool = tools(CTX, stub).unwatch!;

    for (const input of [{}, { watch_id: "" }, { watch_id: 12 }]) {
      const result = await tool.handler(input as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(stub.unwatch).not.toHaveBeenCalled();
  });

  it("maps a service throw through the same error mapping as watch_tasks", async () => {
    const stub = stubService({
      unwatch: vi.fn(async () => {
        throw new WatchNotFoundError("twch_gone");
      }),
    });
    const result = await tools(CTX, stub).unwatch!.handler({ watch_id: "twch_gone" });
    expect(result.content).toEqual({
      error: "watch_not_found",
      message: "task_watch twch_gone not found",
    });
  });

  it("does not require a session context", async () => {
    const stub = stubService();
    const result = await tools({ agentId: "agent_team" }, stub).unwatch!.handler({
      watch_id: "twch_1",
    });
    expect(result.isError).toBeFalsy();
    expect(stub.unwatch).toHaveBeenCalledTimes(1);
  });
});
