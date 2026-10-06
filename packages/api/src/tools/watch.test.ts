/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check, the insert and the already-terminal race. What lives here
 * is the adapter's own logic: input coercion (task_ids filtering, mode
 * defaulting, reason trimming), the session-context guard, and the
 * mapping from the service's four error classes onto stable tool error
 * codes. The service itself is covered by the DB-backed
 * core/services/watch-service suite.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Harness {
  watchService: WatchService;
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
}

function harness(
  opts: { watchTasksImpl?: () => unknown; unwatchImpl?: () => unknown } = {},
): Harness {
  const watchTasks = vi.fn(
    opts.watchTasksImpl ??
      (async () => ({ watchId: "watch_minted", firedImmediately: false })),
  );
  const unwatch = vi.fn(opts.unwatchImpl ?? (async () => undefined));
  return {
    watchService: { watchTasks, unwatch } as unknown as WatchService,
    watchTasks,
    unwatch,
  };
}

const CTX: WatchToolContext = { agentId: "agent_team", sessionId: "sess_now" };

function tools(h: Harness, ctx: WatchToolContext = CTX) {
  const [watchTasks, unwatch] = buildWatchTools(ctx, { watchService: h.watchService });
  return { watchTasks: watchTasks!, unwatch: unwatch! };
}

describe("buildWatchTools descriptors", () => {
  it("returns watch_tasks then unwatch, in that order", () => {
    const list = buildWatchTools(CTX, { watchService: harness().watchService });
    expect(list.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("watch_tasks requires task_ids and enumerates the fire modes", () => {
    const { watchTasks } = tools(harness());
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    const props = watchTasks.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(["all", "any"]);
  });

  it("unwatch requires watch_id", () => {
    const { unwatch } = tools(harness());
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller ids, task ids, mode and trimmed reason to the service", async () => {
    const h = harness();
    const res = await tools(h).watchTasks.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  review the diffs  ",
    });

    expect(h.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_team",
      callerSessionId: "sess_now",
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "review the diffs",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({ watch_id: "watch_minted", fired_immediately: false });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const h = harness();
    const { watchTasks } = tools(h);

    await watchTasks.handler({ task_ids: ["task_a"] });
    await watchTasks.handler({ task_ids: ["task_a"], mode: "either" });
    await watchTasks.handler({ task_ids: ["task_a"], mode: 3 });

    for (const call of h.watchTasks.mock.calls) {
      expect((call[0] as { mode: string }).mode).toBe("all");
    }
  });

  it("omits reason when blank or not a string", async () => {
    const h = harness();
    const { watchTasks } = tools(h);

    await watchTasks.handler({ task_ids: ["task_a"], reason: "   " });
    await watchTasks.handler({ task_ids: ["task_a"], reason: 1 });

    for (const call of h.watchTasks.mock.calls) {
      expect((call[0] as { reason?: string }).reason).toBeUndefined();
    }
  });

  it("drops non-string entries from task_ids rather than passing them through", async () => {
    const h = harness();
    await tools(h).watchTasks.handler({ task_ids: ["task_a", 7, null, "task_b"] });

    expect((h.watchTasks.mock.calls[0]?.[0] as { taskIds: string[] }).taskIds).toEqual([
      "task_a",
      "task_b",
    ]);
  });

  it.each([
    ["an empty array", []],
    ["an all-non-string array", [1, null]],
    ["a non-array", "task_a"],
    ["undefined", undefined],
  ])("rejects task_ids: %s", async (_label, taskIds) => {
    const h = harness();
    const res = await tools(h).watchTasks.handler({ task_ids: taskIds });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects the call when there is no session context to identify the waiter", async () => {
    const h = harness();
    const res = await tools(h, { agentId: "agent_team" }).watchTasks.handler({
      task_ids: ["task_a"],
    });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(String(res.content.message)).toContain("session context");
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("reports fired_immediately when the tasks were already terminal", async () => {
    const h = harness({
      watchTasksImpl: async () => ({ watchId: "watch_raced", firedImmediately: true }),
    });
    const res = await tools(h).watchTasks.handler({ task_ids: ["task_done"] });

    expect(res.content).toEqual({ watch_id: "watch_raced", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("forwards the caller agent id and watch id", async () => {
    const h = harness();
    const res = await tools(h).unwatch.handler({ watch_id: "watch_1" });

    expect(h.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_team",
      watchId: "watch_1",
    });
    expect(res.content).toEqual({ ok: true });
  });

  it("works without a session context — unwatch only needs the agent", async () => {
    const h = harness();
    const res = await tools(h, { agentId: "agent_team" }).unwatch.handler({
      watch_id: "watch_1",
    });

    expect(res.isError).toBeFalsy();
    expect(h.unwatch).toHaveBeenCalled();
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 5],
    ["undefined", undefined],
  ])("rejects watch_id: %s", async (_label, watchId) => {
    const h = harness();
    const res = await tools(h).unwatch.handler({ watch_id: watchId });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(h.unwatch).not.toHaveBeenCalled();
  });
});

describe("service error mapping", () => {
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    ["WatchValidationError", new WatchValidationError("bad mode"), "watch_validation"],
    ["WatchNotFoundError", new WatchNotFoundError("no such watch"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
    ["a thrown non-Error", "exploded", "watch_error"],
  ];

  it.each(cases)("watch_tasks maps %s to %s", async (_label, thrown, code) => {
    const h = harness({
      watchTasksImpl: async () => {
        throw thrown;
      },
    });
    const res = await tools(h).watchTasks.handler({ task_ids: ["task_a"] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe(
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  });

  it.each(cases)("unwatch maps %s to %s", async (_label, thrown, code) => {
    const h = harness({
      unwatchImpl: async () => {
        throw thrown;
      },
    });
    const res = await tools(h).unwatch.handler({ watch_id: "watch_1" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
  });
});
