/**
 * watch_tasks + unwatch MCP tools — unit tests with a faked WatchService.
 *
 * Both handlers are thin adapters, so what's worth pinning is the
 * adapter layer itself: the input coercion an LLM-generated call can
 * get wrong (non-array task_ids, a bogus mode string, a blank reason),
 * the session-context guard, and the mapping from the service's typed
 * error classes onto distinct tool error codes — the agent branches on
 * those codes, so collapsing them would be a silent regression.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import type { AgentTool } from "./types.js";
import { buildWatchTools } from "./watch.js";

const AGENT = "agent_a";
const SESSION = "sess_caller0001";

function makeService(overrides: Partial<WatchService> = {}): WatchService {
  return {
    watchTasks: vi.fn(async () => ({ watchId: "twatch_1", firedImmediately: false })),
    unwatch: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WatchService;
}

function tools(
  service: WatchService,
  ctx: { agentId?: string; sessionId?: string } = {},
): { watch: AgentTool; unwatch: AgentTool } {
  const built = buildWatchTools(
    { agentId: ctx.agentId ?? AGENT, ...("sessionId" in ctx ? { sessionId: ctx.sessionId } : { sessionId: SESSION }) },
    { watchService: service },
  );
  const watch = built.find((t) => t.name === "watch_tasks")!;
  const unwatch = built.find((t) => t.name === "unwatch")!;
  return { watch, unwatch };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order, with schemas", () => {
    const built = buildWatchTools({ agentId: AGENT, sessionId: SESSION }, {
      watchService: makeService(),
    });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
    for (const t of built) {
      expect(t.schema).toMatchObject({ type: "object" });
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("advertises both fire modes in the watch_tasks schema", () => {
    const { watch } = tools(makeService());
    const props = watch.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watch.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("registers the watch and returns the id plus the immediate-fire flag", async () => {
    const service = makeService({
      watchTasks: vi.fn(async () => ({ watchId: "twatch_9", firedImmediately: true })),
    } as Partial<WatchService>);
    const { watch } = tools(service);

    const res = await watch.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the migration result  ",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "twatch_9", fired_immediately: true });
    expect(service.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_1", "task_2"],
      mode: "any",
      // Trimmed.
      reason: "need the migration result",
    });
  });

  it("defaults mode to 'all' and omits a blank or non-string reason", async () => {
    const service = makeService();
    const { watch } = tools(service);

    await watch.handler({ task_ids: ["task_1"] });
    await watch.handler({ task_ids: ["task_1"], mode: "eventually", reason: "   " });
    await watch.handler({ task_ids: ["task_1"], mode: 7, reason: 42 });

    for (const call of vi.mocked(service.watchTasks).mock.calls) {
      expect(call[0]).toMatchObject({ mode: "all", reason: undefined });
    }
  });

  it("drops non-string entries from task_ids", async () => {
    const service = makeService();
    const { watch } = tools(service);

    await watch.handler({ task_ids: ["task_1", 42, null, "task_2", { id: "task_3" }] });
    expect(vi.mocked(service.watchTasks).mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["task_1", "task_2"],
    });
  });

  it("rejects task_ids that is missing, not an array, or empty after filtering", async () => {
    const service = makeService();
    const { watch } = tools(service);

    for (const input of [{}, { task_ids: "task_1" }, { task_ids: [] }, { task_ids: [1, 2] }]) {
      const res = await watch.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
    }
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a call made outside a session context", async () => {
    const service = makeService();
    const { watch } = tools(service, { sessionId: undefined });

    const res = await watch.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(res.content.message).toContain("session context");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("maps each WatchService error class onto its own tool error code", async () => {
    const cases: Array<[Error, string]> = [
      [new WatchAuthError("not your task"), "watch_auth"],
      [new WatchValidationError("task_ids too long"), "watch_validation"],
      [new WatchNotFoundError("twatch_404"), "watch_not_found"],
      [new Error("pg down"), "watch_error"],
    ];
    for (const [thrown, code] of cases) {
      const service = makeService({
        watchTasks: vi.fn(async () => {
          throw thrown;
        }),
      } as Partial<WatchService>);
      const { watch } = tools(service);
      const res = await watch.handler({ task_ids: ["task_1"] });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: code, message: thrown.message });
    }
  });

  it("degrades a non-Error throw to the catch-all code", async () => {
    const service = makeService({
      watchTasks: vi.fn(async () => {
        throw "pool exhausted";
      }),
    } as Partial<WatchService>);
    const { watch } = tools(service);

    const res = await watch.handler({ task_ids: ["task_1"] });
    expect(res.content).toMatchObject({ error: "watch_error", message: "pool exhausted" });
  });
});

describe("unwatch", () => {
  it("cancels the watch scoped to the calling agent", async () => {
    const service = makeService();
    const { unwatch } = tools(service);

    const res = await unwatch.handler({ watch_id: "twatch_1" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(service.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "twatch_1",
    });
  });

  it("rejects a missing, empty or non-string watch_id", async () => {
    const service = makeService();
    const { unwatch } = tools(service);

    for (const input of [{}, { watch_id: "" }, { watch_id: 7 }]) {
      const res = await unwatch.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
    }
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("surfaces an unknown watch as watch_not_found", async () => {
    const service = makeService({
      unwatch: vi.fn(async () => {
        throw new WatchNotFoundError("twatch_404");
      }),
    } as Partial<WatchService>);
    const { unwatch } = tools(service);

    const res = await unwatch.handler({ watch_id: "twatch_404" });
    expect(res.content).toMatchObject({ error: "watch_not_found" });
  });

  it("surfaces another agent's watch as watch_auth", async () => {
    const service = makeService({
      unwatch: vi.fn(async () => {
        throw new WatchAuthError("twatch_1 belongs to agent_b");
      }),
    } as Partial<WatchService>);
    const { unwatch } = tools(service);

    const res = await unwatch.handler({ watch_id: "twatch_1" });
    expect(res.content).toMatchObject({ error: "watch_auth" });
  });
});
