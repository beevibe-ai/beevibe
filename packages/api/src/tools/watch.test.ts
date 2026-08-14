import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

/**
 * watch_tasks + unwatch are deliberately thin: WatchService owns the
 * auth check, the insert, the already-terminal race and the unwatch
 * state machine. What lives *here* is the part the service never sees —
 * coercing untyped MCP input into a typed call, and mapping the
 * service's error classes back onto the wire's stable error codes.
 *
 * So these tests pin two things:
 *   1. what reaches WatchService (defaults applied, junk dropped)
 *   2. what the agent sees when the service throws
 *
 * The service itself is faked throughout — its own behaviour is covered
 * by core's watch-service tests, which need a real Postgres.
 */

const AGENT_ID = "agent_caller";
const SESSION_ID = "sess_current";

function fakeWatchService(
  overrides: Partial<Record<"watchTasks" | "unwatch", unknown>> = {},
): WatchService {
  return {
    watchTasks: vi.fn(async () => ({
      watchId: "tw_1",
      firedImmediately: false,
    })),
    unwatch: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WatchService;
}

function tools(
  ctx: Partial<WatchToolContext> = {},
  service: WatchService = fakeWatchService(),
): { watch: AgentTool; unwatch: AgentTool; service: WatchService } {
  const built = buildWatchTools(
    { agentId: AGENT_ID, sessionId: SESSION_ID, ...ctx },
    { watchService: service },
  );
  const watch = built.find((t) => t.name === "watch_tasks");
  const unwatch = built.find((t) => t.name === "unwatch");
  if (!watch || !unwatch) throw new Error("expected both watch tools");
  return { watch, unwatch, service };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, both with a task_ids/watch_id schema", () => {
    const { watch, unwatch } = tools();

    expect(watch.schema.required).toEqual(["task_ids"]);
    expect(unwatch.schema.required).toEqual(["watch_id"]);
    // The descriptions are the agent-facing contract, so a non-trivial
    // one is part of the surface, not decoration.
    expect(watch.description).toContain("watch");
    expect(unwatch.description.length).toBeGreaterThan(0);
  });

  it("advertises exactly the modes the domain defines", () => {
    const { watch } = tools();
    const props = watch.schema.properties as {
      mode: { enum: string[] };
    };
    expect(props.mode.enum).toEqual(["all", "any"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const { watch, service } = tools();

    const res = await watch.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the build result  ",
    });

    expect(service.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the build result",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "tw_1", fired_immediately: false });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const { watch, service } = tools();

    await watch.handler({ task_ids: ["task_a"] });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("defaults mode to 'all' when the value is not a known mode", async () => {
    const { watch, service } = tools();

    await watch.handler({ task_ids: ["task_a"], mode: "eventually" });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("drops a whitespace-only reason rather than forwarding it", async () => {
    const { watch, service } = tools();

    await watch.handler({ task_ids: ["task_a"], reason: "   " });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });

  it("drops a non-string reason", async () => {
    const { watch, service } = tools();

    await watch.handler({ task_ids: ["task_a"], reason: 42 });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watch, service } = tools();

    await watch.handler({ task_ids: ["task_a", 7, null, "task_b"] });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_a", "task_b"] }),
    );
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const service = fakeWatchService({
      watchTasks: vi.fn(async () => ({ watchId: "tw_9", firedImmediately: true })),
    });
    const { watch } = tools({}, service);

    const res = await watch.handler({ task_ids: ["task_done"] });

    expect(res.content).toEqual({ watch_id: "tw_9", fired_immediately: true });
  });

  it("rejects an empty task_ids array without calling the service", async () => {
    const { watch, service } = tools();

    const res = await watch.handler({ task_ids: [] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects task_ids that contain no strings at all", async () => {
    const { watch, service } = tools();

    const res = await watch.handler({ task_ids: [1, 2, 3] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a non-array task_ids", async () => {
    const { watch, service } = tools();

    const res = await watch.handler({ task_ids: "task_a" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch outside a session context", async () => {
    // Without a session id there is no waiter to re-invoke, so the
    // watch would fire into nowhere. Caught before the service call.
    const { watch, service } = tools({ sessionId: undefined });

    const res = await watch.handler({ task_ids: ["task_a"] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toContain("session context");
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("validates task_ids before the missing-session check", async () => {
    // Both are invalid here; the array check is the one that reports,
    // which keeps the message pointed at the argument the agent passed.
    const { watch } = tools({ sessionId: undefined });

    const res = await watch.handler({ task_ids: [] });

    expect(res.content.message).toContain("non-empty array");
  });
});

describe("watch_tasks error mapping", () => {
  it.each([
    ["watch_auth", new WatchAuthError("not your task")],
    ["watch_validation", new WatchValidationError("bad mode")],
    ["watch_not_found", new WatchNotFoundError("tw_missing")],
  ])("maps a %s failure onto its stable code", async (code, thrown) => {
    const service = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw thrown;
      }),
    });
    const { watch } = tools({}, service);

    const res = await watch.handler({ task_ids: ["task_a"] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe((thrown as Error).message);
  });

  it("maps an unrecognised Error onto the generic watch_error code", async () => {
    const service = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    });
    const { watch } = tools({}, service);

    const res = await watch.handler({ task_ids: ["task_a"] });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_error",
      message: "connection reset",
    });
  });

  it("stringifies a non-Error throw", async () => {
    const service = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw "pool exhausted";
      }),
    });
    const { watch } = tools({}, service);

    const res = await watch.handler({ task_ids: ["task_a"] });

    expect(res.content).toEqual({
      error: "watch_error",
      message: "pool exhausted",
    });
  });
});

describe("unwatch", () => {
  it("cancels the watch and reports ok", async () => {
    const { unwatch, service } = tools();

    const res = await unwatch.handler({ watch_id: "tw_1" });

    expect(service.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "tw_1",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
  });

  it("rejects a missing watch_id without calling the service", async () => {
    const { unwatch, service } = tools();

    const res = await unwatch.handler({});

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("rejects an empty-string watch_id", async () => {
    const { unwatch, service } = tools();

    const res = await unwatch.handler({ watch_id: "" });

    expect(res.isError).toBe(true);
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("rejects a non-string watch_id", async () => {
    const { unwatch, service } = tools();

    const res = await unwatch.handler({ watch_id: { id: "tw_1" } });

    expect(res.isError).toBe(true);
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("surfaces an auth failure with the watch_auth code", async () => {
    const service = fakeWatchService({
      unwatch: vi.fn(async () => {
        throw new WatchAuthError("watch belongs to another agent");
      }),
    });
    const { unwatch } = tools({}, service);

    const res = await unwatch.handler({ watch_id: "tw_other" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_auth");
  });

  it("surfaces a not-found failure with the watch_not_found code", async () => {
    const service = fakeWatchService({
      unwatch: vi.fn(async () => {
        throw new WatchNotFoundError("tw_gone");
      }),
    });
    const { unwatch } = tools({}, service);

    const res = await unwatch.handler({ watch_id: "tw_gone" });

    expect(res.content.error).toBe("watch_not_found");
  });

  it("does not need a session context — only the caller agent", async () => {
    // unwatch identifies the row by id, so unlike watch_tasks it stays
    // usable outside a session.
    const { unwatch, service } = tools({ sessionId: undefined });

    const res = await unwatch.handler({ watch_id: "tw_1" });

    expect(res.content).toEqual({ ok: true });
    expect(service.unwatch).toHaveBeenCalled();
  });
});
