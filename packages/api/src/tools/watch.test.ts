/**
 * watch_tasks + unwatch handler tests.
 *
 * These tools are thin adapters over WatchService, so what's worth
 * locking is the adapter layer: the input coercion done before the
 * service call, and the mapping from the service's four error classes
 * onto the four `error` codes an agent branches on.
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
  services: { watchService: WatchService };
  watchArgs: () => Record<string, unknown> | undefined;
  unwatchArgs: () => Record<string, unknown> | undefined;
}

function harness(
  opts: { watchThrows?: unknown; unwatchThrows?: unknown } = {},
): Harness {
  let watchArgs: Record<string, unknown> | undefined;
  let unwatchArgs: Record<string, unknown> | undefined;

  const watchService = {
    watchTasks: vi.fn(async (input: Record<string, unknown>) => {
      watchArgs = input;
      if (opts.watchThrows !== undefined) throw opts.watchThrows;
      return { watchId: "tw_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: Record<string, unknown>) => {
      unwatchArgs = input;
      if (opts.unwatchThrows !== undefined) throw opts.unwatchThrows;
    }),
  } as unknown as WatchService;

  return {
    services: { watchService },
    watchArgs: () => watchArgs,
    unwatchArgs: () => unwatchArgs,
  };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" };

function tools(h: Harness, ctx: WatchToolContext = CTX) {
  const built = buildWatchTools(ctx, h.services);
  const byName = Object.fromEntries(built.map((t) => [t.name, t]));
  return { list: built, watch: byName.watch_tasks!, unwatch: byName.unwatch! };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks then unwatch", () => {
    expect(tools(harness()).list.map((t) => t.name)).toEqual([
      "watch_tasks",
      "unwatch",
    ]);
  });

  it("declares the schemas the descriptions promise", () => {
    const { watch, unwatch } = tools(harness());
    expect(watch.schema.required).toEqual(["task_ids"]);
    const props = watch.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const h = harness();
    const result = await tools(h).watch.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(h.watchArgs()).toEqual({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "tw_1", fired_immediately: false });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const h = harness();
    await tools(h).watch.handler({ task_ids: ["task_1"] });
    expect(h.watchArgs()?.mode).toBe("all");

    await tools(h).watch.handler({ task_ids: ["task_1"], mode: "eventually" });
    expect(h.watchArgs()?.mode).toBe("all");
  });

  it("drops a blank reason instead of forwarding an empty string", async () => {
    const h = harness();
    await tools(h).watch.handler({ task_ids: ["task_1"], reason: "   " });
    expect(h.watchArgs()?.reason).toBeUndefined();

    await tools(h).watch.handler({ task_ids: ["task_1"], reason: 7 });
    expect(h.watchArgs()?.reason).toBeUndefined();
  });

  it("filters non-string entries out of task_ids", async () => {
    const h = harness();
    await tools(h).watch.handler({ task_ids: ["task_1", 2, null, "task_3"] });
    expect(h.watchArgs()?.taskIds).toEqual(["task_1", "task_3"]);
  });

  it.each([
    ["omitted", undefined],
    ["not an array", "task_1"],
    ["empty", []],
    ["all non-strings", [1, 2]],
  ])("rejects task_ids that are %s", async (_label, taskIds) => {
    const h = harness();
    const result = await tools(h).watch.handler({ task_ids: taskIds });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchArgs()).toBeUndefined();
  });

  it("refuses to register without a session context", async () => {
    const h = harness();
    const result = await tools(h, { agentId: "agent_a" }).watch.handler({
      task_ids: ["task_1"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchArgs()).toBeUndefined();
  });

  it("reports fired_immediately when the tasks were already terminal", async () => {
    const h = harness();
    (h.services.watchService.watchTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      watchId: "tw_now",
      firedImmediately: true,
    });

    const result = await tools(h).watch.handler({ task_ids: ["task_1"] });
    expect(result.content).toEqual({ watch_id: "tw_now", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("forwards the caller agent id and watch id", async () => {
    const h = harness();
    const result = await tools(h).unwatch.handler({ watch_id: "tw_1" });

    expect(h.unwatchArgs()).toEqual({ callerAgentId: "agent_a", watchId: "tw_1" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["not a string", 123],
  ])("rejects watch_id that is %s", async (_label, watchId) => {
    const h = harness();
    const result = await tools(h).unwatch.handler({ watch_id: watchId });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.unwatchArgs()).toBeUndefined();
  });
});

describe("service error mapping", () => {
  // Both tools funnel through the same `caughtError` helper, so each
  // class is checked on one tool and the shared helper is exercised from
  // both entry points.
  it.each([
    [new WatchAuthError("not yours"), "watch_auth", "not yours"],
    [new WatchValidationError("bad ids"), "watch_validation", "bad ids"],
    [new WatchNotFoundError("tw_9"), "watch_not_found", "task_watch tw_9 not found"],
    [new Error("pool exhausted"), "watch_error", "pool exhausted"],
    ["raw string", "watch_error", "raw string"],
  ])("maps %s to a coded tool error", async (thrown, code, message) => {
    const h = harness({ watchThrows: thrown });
    const result = await tools(h).watch.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: code, message });
  });

  it("maps errors thrown out of unwatch too", async () => {
    const h = harness({ unwatchThrows: new WatchAuthError("not your watch") });
    const result = await tools(h).unwatch.handler({ watch_id: "tw_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "watch_auth",
      message: "not your watch",
    });
  });
});
