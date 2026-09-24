/**
 * watch_tasks + unwatch MCP tools — unit tests with a fake WatchService.
 *
 * The tools are thin adapters, so what's worth pinning is the adapter
 * layer itself: input coercion (a non-array `task_ids`, a mixed array,
 * a blank `reason`, an unknown `mode`), the session-context guard, and
 * the error taxonomy — each WatchService error class has to land on its
 * own stable `error` code, because agents branch on those codes.
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

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function makeService(over: Partial<WatchService> = {}): WatchService {
  return {
    watchTasks: vi.fn(async () => ({ watchId: "watch_1", firedImmediately: false })),
    unwatch: vi.fn(async () => undefined),
    ...over,
  } as unknown as WatchService;
}

function tools(ctx: WatchToolContext = CTX, service = makeService()) {
  const [watchTasks, unwatch] = buildWatchTools(ctx, { watchService: service });
  return { watchTasks: watchTasks as AgentTool, unwatch: unwatch as AgentTool, service };
}

/** The sole argument the fake service saw on its nth call. */
function argOf<T>(fn: unknown, call = 0): T {
  return (fn as ReturnType<typeof vi.fn>).mock.calls[call]?.[0] as T;
}

interface WatchTasksArgs {
  callerAgentId: string;
  callerSessionId: string;
  taskIds: string[];
  mode: string;
  reason?: string;
}

describe("buildWatchTools", () => {
  it("exposes exactly watch_tasks and unwatch", () => {
    const built = buildWatchTools(CTX, { watchService: makeService() });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both fire modes in the watch_tasks schema", () => {
    const { watchTasks } = tools();
    const props = watchTasks.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(expect.arrayContaining(["all", "any"]));
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("registers a watch and returns the id plus the immediate-fire flag", async () => {
    const service = makeService({
      watchTasks: vi.fn(async () => ({ watchId: "watch_9", firedImmediately: true })),
    } as Partial<WatchService>);
    const { watchTasks } = tools(CTX, service);

    const res = await watchTasks.handler({ task_ids: ["task_1", "task_2"], mode: "any" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "watch_9", fired_immediately: true });
    expect(service.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: undefined,
    });
  });

  it("defaults mode to 'all' when omitted or unrecognized", async () => {
    const { watchTasks, service } = tools();
    await watchTasks.handler({ task_ids: ["task_1"] });
    await watchTasks.handler({ task_ids: ["task_1"], mode: "eventually" });
    for (let i = 0; i < 2; i++) {
      expect(argOf<WatchTasksArgs>(service.watchTasks, i).mode).toBe("all");
    }
  });

  it("trims a reason and drops a blank one", async () => {
    const { watchTasks, service } = tools();
    await watchTasks.handler({ task_ids: ["task_1"], reason: "  need the diff  " });
    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    await watchTasks.handler({ task_ids: ["task_1"], reason: 7 });
    expect(argOf<WatchTasksArgs>(service.watchTasks, 0).reason).toBe("need the diff");
    expect(argOf<WatchTasksArgs>(service.watchTasks, 1).reason).toBeUndefined();
    expect(argOf<WatchTasksArgs>(service.watchTasks, 2).reason).toBeUndefined();
  });

  it("keeps only the string entries of task_ids", async () => {
    const { watchTasks, service } = tools();
    await watchTasks.handler({ task_ids: ["task_1", 42, null, "task_2"] });
    expect(argOf<WatchTasksArgs>(service.watchTasks).taskIds).toEqual(["task_1", "task_2"]);
  });

  it("rejects task_ids that isn't a non-empty array of strings", async () => {
    const { watchTasks, service } = tools();
    for (const input of [{}, { task_ids: [] }, { task_ids: "task_1" }, { task_ids: [1, 2] }]) {
      const res = await watchTasks.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
    }
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register outside a session context", async () => {
    const { watchTasks, service } = tools({ agentId: "agent_a" });
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(res.content.message).toContain("session context");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("maps each WatchService error class to its own code", async () => {
    const cases: Array<[Error, string]> = [
      [new WatchAuthError("not yours"), "watch_auth"],
      [new WatchValidationError("bad ids"), "watch_validation"],
      [new WatchNotFoundError("watch_x"), "watch_not_found"],
      [new Error("pg down"), "watch_error"],
    ];
    for (const [thrown, code] of cases) {
      const service = makeService({
        watchTasks: vi.fn(async () => {
          throw thrown;
        }),
      } as Partial<WatchService>);
      const { watchTasks } = tools(CTX, service);
      const res = await watchTasks.handler({ task_ids: ["task_1"] });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: code, message: thrown.message });
    }
  });

  it("envelopes a non-Error throw rather than leaking it", async () => {
    const service = makeService({
      watchTasks: vi.fn(async () => {
        throw "string failure";
      }),
    } as Partial<WatchService>);
    const { watchTasks } = tools(CTX, service);
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.content).toEqual({ error: "watch_error", message: "string failure" });
  });
});

describe("unwatch", () => {
  it("cancels the watch and reports ok", async () => {
    const { unwatch, service } = tools();
    const res = await unwatch.handler({ watch_id: "watch_1" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(service.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "watch_1",
    });
  });

  it("rejects a missing or non-string watch_id", async () => {
    const { unwatch, service } = tools();
    for (const input of [{}, { watch_id: "" }, { watch_id: 5 }]) {
      const res = await unwatch.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
    }
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("surfaces a not-found watch under its own code", async () => {
    const service = makeService({
      unwatch: vi.fn(async () => {
        throw new WatchNotFoundError("watch_gone");
      }),
    } as Partial<WatchService>);
    const { unwatch } = tools(CTX, service);
    const res = await unwatch.handler({ watch_id: "watch_gone" });
    expect(res.content).toMatchObject({ error: "watch_not_found" });
  });

  it("surfaces someone else's watch as an auth failure", async () => {
    const service = makeService({
      unwatch: vi.fn(async () => {
        throw new WatchAuthError("watch does not belong to caller");
      }),
    } as Partial<WatchService>);
    const { unwatch } = tools(CTX, service);
    const res = await unwatch.handler({ watch_id: "watch_theirs" });
    expect(res.content).toMatchObject({ error: "watch_auth" });
  });
});
