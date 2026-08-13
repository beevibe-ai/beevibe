/**
 * `watch_tasks` + `unwatch` MCP tools — unit tests with a fake
 * WatchService.
 *
 * The tools are thin adapters, so what's worth pinning is exactly the
 * part that isn't the service: the input coercion an LLM caller will
 * get wrong (a bare string instead of an array, a nonsense `mode`, a
 * blank `reason`), the missing-session guard, and the error-class →
 * tool-error-code mapping — an agent branches on those codes, so a
 * WatchAuthError degrading to a generic `watch_error` would be a real
 * behaviour change.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

const AGENT = "agent_watcher001";
const SESSION = "sess_watcher0001";

function makeService(): WatchService {
  return {
    watchTasks: vi.fn(async () => ({ watchId: "twatch_1", firedImmediately: false })),
    unwatch: vi.fn(async () => undefined),
  } as unknown as WatchService;
}

function makeTools(ctx: Partial<WatchToolContext> = {}, watchService = makeService()) {
  const [watchTasks, unwatch] = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...ctx },
    { watchService },
  );
  return { watchTasks: watchTasks!, unwatch: unwatch!, watchService };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watchTasks, unwatch } = makeTools();

    expect(watchTasks.name).toBe("watch_tasks");
    expect(unwatch.name).toBe("unwatch");
  });

  it("advertises the mode enum the service accepts", () => {
    const { watchTasks } = makeTools();
    const props = watchTasks.schema.properties as Record<string, { enum?: string[] }>;

    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("registers the watch and reports the service's result", async () => {
    const { watchTasks, watchService } = makeTools();
    vi.mocked(watchService.watchTasks).mockResolvedValue({
      watchId: "twatch_abc",
      firedImmediately: true,
    });

    const res = await watchTasks.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  waiting on the migration  ",
    });

    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({ watch_id: "twatch_abc", fired_immediately: true });
    expect(watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "waiting on the migration",
    });
  });

  it("defaults to mode 'all' when the caller omits it or sends something unknown", async () => {
    const { watchTasks, watchService } = makeTools();

    await watchTasks.handler({ task_ids: ["task_a"] });
    await watchTasks.handler({ task_ids: ["task_a"], mode: "sometimes" });
    await watchTasks.handler({ task_ids: ["task_a"], mode: 7 });

    for (const call of vi.mocked(watchService.watchTasks).mock.calls) {
      expect(call[0].mode).toBe("all");
    }
  });

  it("drops a blank or non-string reason rather than forwarding it", async () => {
    const { watchTasks, watchService } = makeTools();

    await watchTasks.handler({ task_ids: ["task_a"], reason: "   " });
    await watchTasks.handler({ task_ids: ["task_a"], reason: 42 });

    for (const call of vi.mocked(watchService.watchTasks).mock.calls) {
      expect(call[0].reason).toBeUndefined();
    }
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watchTasks, watchService } = makeTools();

    await watchTasks.handler({ task_ids: ["task_a", 7, null, "task_b"] });

    expect(vi.mocked(watchService.watchTasks).mock.calls[0]?.[0].taskIds).toEqual([
      "task_a",
      "task_b",
    ]);
  });

  it("rejects task_ids that is missing, not an array, or empty after filtering", async () => {
    const { watchTasks, watchService } = makeTools();

    const cases = [{}, { task_ids: "task_a" }, { task_ids: [] }, { task_ids: [1, 2] }];
    for (const input of cases) {
      const res = await watchTasks.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
      expect(res.content.message).toContain("non-empty array");
    }
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch outside a session context", async () => {
    const { watchTasks, watchService } = makeTools({ sessionId: undefined });

    const res = await watchTasks.handler({ task_ids: ["task_a"] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toContain("session context");
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("maps each WatchService error class to its own tool error code", async () => {
    const cases = [
      [new WatchAuthError("not your task"), "watch_auth", "not your task"],
      [new WatchValidationError("too many tasks"), "watch_validation", "too many tasks"],
      [
        new WatchNotFoundError("twatch_gone"),
        "watch_not_found",
        "task_watch twatch_gone not found",
      ],
      [new Error("pool timeout"), "watch_error", "pool timeout"],
      ["raw string blowup", "watch_error", "raw string blowup"],
    ] as const;

    for (const [thrown, code, message] of cases) {
      const { watchTasks, watchService } = makeTools();
      vi.mocked(watchService.watchTasks).mockRejectedValue(thrown);

      const res = await watchTasks.handler({ task_ids: ["task_a"] });

      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message });
    }
  });
});

describe("unwatch", () => {
  it("cancels the watch for the calling agent", async () => {
    const { unwatch, watchService } = makeTools();

    const res = await unwatch.handler({ watch_id: "twatch_abc" });

    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({ ok: true });
    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "twatch_abc",
    });
  });

  it("rejects a missing, blank, or non-string watch_id", async () => {
    const { unwatch, watchService } = makeTools();

    for (const input of [{}, { watch_id: "" }, { watch_id: 12 }]) {
      const res = await unwatch.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
    }
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });

  it("maps a service throw through the same error mapping", async () => {
    const { unwatch, watchService } = makeTools();
    vi.mocked(watchService.unwatch).mockRejectedValue(
      new WatchAuthError("watch belongs to another agent"),
    );

    const res = await unwatch.handler({ watch_id: "twatch_abc" });

    expect(res.content).toEqual({
      error: "watch_auth",
      message: "watch belongs to another agent",
    });
  });
});
