/**
 * `buildWatchTools` — the watch_tasks / unwatch MCP pair.
 *
 * Both tools are thin adapters: they normalize the agent-supplied JSON
 * (which MCP does not validate against the declared schema — the agent
 * can send anything), then delegate to `WatchService` and translate its
 * typed errors into the tool-error envelope. Those two translations are
 * what this suite pins, with a `vi.fn()` service standing in for the
 * real one.
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

const AGENT = "agent_a";
const SESSION = "sess_caller0001";

function makeService(overrides: Partial<WatchService> = {}): WatchService {
  return {
    watchTasks: vi.fn(async () => ({ watchId: "watch_1", firedImmediately: false })),
    unwatch: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WatchService;
}

function tools(
  service: WatchService,
  ctx: Partial<WatchToolContext> = {},
): { watchTasks: AgentTool; unwatch: AgentTool } {
  const built = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...ctx },
    { watchService: service },
  );
  const byName = new Map(built.map((t) => [t.name, t]));
  return {
    watchTasks: byName.get("watch_tasks")!,
    unwatch: byName.get("unwatch")!,
  };
}

describe("buildWatchTools", () => {
  it("exposes exactly watch_tasks and unwatch", () => {
    const built = buildWatchTools(
      { agentId: AGENT, sessionId: SESSION },
      { watchService: makeService() },
    );
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares the fire modes in the watch_tasks schema so the agent sees them", () => {
    const { watchTasks } = tools(makeService());
    const props = watchTasks.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("registers a watch and returns the service's ids", async () => {
    const service = makeService({
      watchTasks: vi.fn(async () => ({ watchId: "watch_42", firedImmediately: true })),
    } as Partial<WatchService>);
    const { watchTasks } = tools(service);
    const res = await watchTasks.handler({ task_ids: ["task_1", "task_2"] });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "watch_42", fired_immediately: true });
    expect(service.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
  });

  it("passes a valid mode through", async () => {
    const service = makeService();
    const { watchTasks } = tools(service);
    await watchTasks.handler({ task_ids: ["task_1"], mode: "any" });
    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "any" }),
    );
  });

  it("defaults an unrecognized mode to 'all' rather than rejecting the call", async () => {
    const service = makeService();
    const { watchTasks } = tools(service);
    await watchTasks.handler({ task_ids: ["task_1"], mode: "eventually" });
    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("trims the reason and drops a blank one", async () => {
    const service = makeService();
    const { watchTasks } = tools(service);
    await watchTasks.handler({ task_ids: ["task_1"], reason: "  deploy check  " });
    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "deploy check" }),
    );

    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    expect(service.watchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });

  it("drops non-string entries from task_ids", async () => {
    const service = makeService();
    const { watchTasks } = tools(service);
    await watchTasks.handler({ task_ids: ["task_1", 7, null, "task_2"] });
    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_1", "task_2"] }),
    );
  });

  it("rejects an empty task_ids array", async () => {
    const service = makeService();
    const { watchTasks } = tools(service);
    const res = await watchTasks.handler({ task_ids: [] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a non-array task_ids", async () => {
    const service = makeService();
    const { watchTasks } = tools(service);
    const res = await watchTasks.handler({ task_ids: "task_1" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects an all-non-string task_ids array", async () => {
    const service = makeService();
    const { watchTasks } = tools(service);
    const res = await watchTasks.handler({ task_ids: [1, 2, 3] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
  });

  it("errors when there's no session context to identify the waiter", async () => {
    const service = makeService();
    const { watchTasks } = tools(service, { sessionId: undefined });
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toContain("session context");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });
});

describe("unwatch", () => {
  it("cancels the watch and reports ok", async () => {
    const service = makeService();
    const { unwatch } = tools(service);
    const res = await unwatch.handler({ watch_id: "watch_1" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(service.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "watch_1",
    });
  });

  it("rejects a missing watch_id", async () => {
    const service = makeService();
    const { unwatch } = tools(service);
    const res = await unwatch.handler({});
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("rejects an empty-string watch_id", async () => {
    const service = makeService();
    const { unwatch } = tools(service);
    const res = await unwatch.handler({ watch_id: "" });
    expect(res.isError).toBe(true);
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("rejects a non-string watch_id", async () => {
    const service = makeService();
    const { unwatch } = tools(service);
    const res = await unwatch.handler({ watch_id: 12345 });
    expect(res.isError).toBe(true);
    expect(service.unwatch).not.toHaveBeenCalled();
  });
});

describe("error translation", () => {
  // The agent branches on these codes, so the mapping from the
  // service's typed errors is part of the wire contract.
  const cases: ReadonlyArray<readonly [string, Error, string]> = [
    ["auth", new WatchAuthError("task belongs to another chain"), "watch_auth"],
    ["validation", new WatchValidationError("too many tasks"), "watch_validation"],
    ["not found", new WatchNotFoundError("no such watch"), "watch_not_found"],
    ["generic Error", new Error("pg: connection reset"), "watch_error"],
  ];

  for (const [label, err, code] of cases) {
    it(`maps a ${label} throw from watchTasks to ${code}`, async () => {
      const service = makeService({
        watchTasks: vi.fn(async () => {
          throw err;
        }),
      } as Partial<WatchService>);
      const { watchTasks } = tools(service);
      const res = await watchTasks.handler({ task_ids: ["task_1"] });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe(code);
      expect(res.content.message).toBe(err.message);
    });

    it(`maps a ${label} throw from unwatch to ${code}`, async () => {
      const service = makeService({
        unwatch: vi.fn(async () => {
          throw err;
        }),
      } as Partial<WatchService>);
      const { unwatch } = tools(service);
      const res = await unwatch.handler({ watch_id: "watch_1" });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe(code);
    });
  }

  it("stringifies a non-Error throw", async () => {
    const service = makeService({
      watchTasks: vi.fn(async () => {
        throw "kaboom";
      }),
    } as Partial<WatchService>);
    const { watchTasks } = tools(service);
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.content.error).toBe("watch_error");
    expect(res.content.message).toBe("kaboom");
  });
});
