import { describe, expect, it, vi } from "vitest";
import { TASK_WATCH_MODES } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksResult,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

/**
 * watch_tasks + unwatch are thin adapters over WatchService — the
 * service owns the auth check, the insert and the already-terminal race.
 * What lives *here*, and so is what these tests pin:
 *
 *   - argument coercion (task_ids filtering, mode default, reason trim)
 *   - the session-context precondition, which the service can't check
 *     because it only ever sees a string
 *   - the error-class → error-code mapping every calling agent branches
 *     on; a silently renamed code is a broken wire contract
 */

const AGENT_ID = "agent_waiter";
const SESSION_ID = "sess_current";

function fakeWatchService(
  opts: {
    result?: WatchTasksResult;
    watchThrows?: unknown;
    unwatchThrows?: unknown;
  } = {},
): WatchService {
  return {
    watchTasks: vi.fn(async () => {
      if (opts.watchThrows !== undefined) throw opts.watchThrows;
      return opts.result ?? { watchId: "twatch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async () => {
      if (opts.unwatchThrows !== undefined) throw opts.unwatchThrows;
    }),
  } as unknown as WatchService;
}

function tools(
  ctx: Partial<WatchToolContext> = {},
  svcOpts: Parameters<typeof fakeWatchService>[0] = {},
): { watchTasks: AgentTool; unwatch: AgentTool; watchService: WatchService } {
  const watchService = fakeWatchService(svcOpts);
  const built = buildWatchTools(
    { agentId: AGENT_ID, sessionId: SESSION_ID, ...ctx },
    { watchService },
  );
  const byName = (n: string) => {
    const t = built.find((x) => x.name === n);
    if (!t) throw new Error(`no tool named ${n}`);
    return t;
  };
  return {
    watchTasks: byName("watch_tasks"),
    unwatch: byName("unwatch"),
    watchService,
  };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const built = buildWatchTools(
      { agentId: AGENT_ID, sessionId: SESSION_ID },
      { watchService: fakeWatchService() },
    );
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the modes from the domain constant, so the enum can't drift", () => {
    const { watchTasks } = tools();
    const props = watchTasks.schema.properties as Record<
      string,
      { enum?: string[] } | undefined
    >;
    expect(props.mode?.enum).toEqual([...TASK_WATCH_MODES]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks — task_ids", () => {
  it.each([
    ["missing", undefined],
    ["an empty array", []],
    ["not an array", "task_1"],
    ["an array with no strings", [1, null, { id: "x" }]],
  ])("rejects %s with watch_validation", async (_label, task_ids) => {
    const { watchTasks, watchService } = tools();
    const res = await watchTasks.handler({ task_ids });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("filters non-string entries out rather than rejecting the whole call", async () => {
    const { watchTasks, watchService } = tools();
    const res = await watchTasks.handler({
      task_ids: ["task_1", 2, null, "task_3"],
    });
    expect(res.isError).toBeUndefined();
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_1", "task_3"] }),
    );
  });
});

describe("watch_tasks — mode and reason", () => {
  it("defaults mode to 'all'", async () => {
    const { watchTasks, watchService } = tools();
    await watchTasks.handler({ task_ids: ["task_1"] });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it.each([...TASK_WATCH_MODES])("passes a valid mode (%s) through", async (mode) => {
    const { watchTasks, watchService } = tools();
    await watchTasks.handler({ task_ids: ["task_1"], mode });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode }),
    );
  });

  it.each([
    ["an unknown string", "eventually"],
    ["a non-string", 1],
  ])("falls back to 'all' for %s", async (_label, mode) => {
    const { watchTasks, watchService } = tools();
    await watchTasks.handler({ task_ids: ["task_1"], mode });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("trims a reason and drops a blank one", async () => {
    const { watchTasks, watchService } = tools();
    await watchTasks.handler({ task_ids: ["task_1"], reason: "  need result  " });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "need result" }),
    );

    const second = tools();
    await second.watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    expect(second.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });
});

describe("watch_tasks — session context", () => {
  it("refuses when there is no session id to attribute the watch to", async () => {
    const { watchTasks, watchService } = tools({ sessionId: undefined });
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/inside a session context/);
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("forwards the caller agent + session as the waiter", async () => {
    const { watchTasks, watchService } = tools();
    await watchTasks.handler({ task_ids: ["task_1"] });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        callerAgentId: AGENT_ID,
        callerSessionId: SESSION_ID,
      }),
    );
  });
});

describe("watch_tasks — success envelope", () => {
  it("maps the service result onto the agent-facing snake_case keys", async () => {
    const { watchTasks } = tools(
      {},
      { result: { watchId: "twatch_42", firedImmediately: true } },
    );
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      watch_id: "twatch_42",
      fired_immediately: true,
    });
  });
});

describe("watch error mapping", () => {
  it.each([
    ["WatchAuthError", new WatchAuthError("not yours"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("bad mode"),
      "watch_validation",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("twatch_9"),
      "watch_not_found",
    ],
    ["a plain Error", new Error("pool died"), "watch_error"],
    ["a thrown non-Error", "string blew up", "watch_error"],
  ])("maps %s to %s on watch_tasks", async (_label, thrown, code) => {
    const { watchTasks } = tools({}, { watchThrows: thrown });
    const res = await watchTasks.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(typeof res.content.message).toBe("string");
    expect(res.content.message).not.toBe("");
  });

  it("uses the same mapping on unwatch", async () => {
    const { unwatch } = tools({}, { unwatchThrows: new WatchAuthError("nope") });
    const res = await unwatch.handler({ watch_id: "twatch_1" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_auth");
  });

  it("stringifies a thrown non-Error for the message", async () => {
    const { unwatch } = tools({}, { unwatchThrows: { code: 42 } });
    const res = await unwatch.handler({ watch_id: "twatch_1" });
    expect(res.content.error).toBe("watch_error");
    expect(res.content.message).toBe("[object Object]");
  });
});

describe("unwatch", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a string", 123],
  ])("rejects a %s watch_id", async (_label, watch_id) => {
    const { unwatch, watchService } = tools();
    const res = await unwatch.handler({ watch_id });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });

  it("returns { ok: true } and forwards the caller agent", async () => {
    const { unwatch, watchService } = tools();
    const res = await unwatch.handler({ watch_id: "twatch_7" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "twatch_7",
    });
  });

  it("requires only watch_id in its schema", () => {
    const { unwatch } = tools();
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});
