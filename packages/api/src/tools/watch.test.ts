import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Fake {
  watchService: WatchService;
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
}

function fakeWatchService(overrides: Partial<Fake> = {}): Fake {
  const watchTasks =
    overrides.watchTasks ??
    vi.fn(async () => ({ watchId: "watch_1", firedImmediately: false }));
  const unwatch = overrides.unwatch ?? vi.fn(async () => undefined);
  return {
    watchTasks,
    unwatch,
    watchService: { watchTasks, unwatch } as unknown as WatchService,
  };
}

function tools(ctx: Partial<WatchToolContext> = {}, fake = fakeWatchService()) {
  const built = buildWatchTools(
    { agentId: "agent_a", sessionId: "sess_1", ...ctx },
    { watchService: fake.watchService },
  );
  const byName = (name: string) => {
    const t = built.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not built`);
    return t;
  };
  return { built, fake, watchTasks: byName("watch_tasks"), unwatch: byName("unwatch") };
}

describe("buildWatchTools", () => {
  it("builds watch_tasks and unwatch, in that order", () => {
    const { built } = tools();
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both modes on the watch_tasks schema", () => {
    const { watchTasks } = tools();
    const props = watchTasks.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    expect(props.task_ids?.minItems).toBe(1);
  });
});

describe("watch_tasks handler", () => {
  it("passes caller identity, ids and mode through to the service", async () => {
    const fake = fakeWatchService();
    const { watchTasks } = tools({}, fake);

    const result = await watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first signal  ",
    });

    expect(fake.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need the first signal",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "watch_1",
      fired_immediately: false,
    });
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const fake = fakeWatchService({
      watchTasks: vi.fn(async () => ({
        watchId: "watch_9",
        firedImmediately: true,
      })),
    });
    const { watchTasks } = tools({}, fake);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "watch_9",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when absent or not a known mode", async () => {
    const fake = fakeWatchService();
    const { watchTasks } = tools({}, fake);

    await watchTasks.handler({ task_ids: ["task_1"] });
    await watchTasks.handler({ task_ids: ["task_1"], mode: "sometimes" });
    await watchTasks.handler({ task_ids: ["task_1"], mode: 7 });

    for (const call of fake.watchTasks.mock.calls) {
      expect(call[0]).toMatchObject({ mode: "all" });
    }
  });

  it("drops non-string entries from task_ids", async () => {
    const fake = fakeWatchService();
    const { watchTasks } = tools({}, fake);

    await watchTasks.handler({ task_ids: ["task_1", 42, null, "task_2"] });

    expect(fake.watchTasks.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["task_1", "task_2"],
    });
  });

  it("omits a reason that is missing, blank, or not a string", async () => {
    const fake = fakeWatchService();
    const { watchTasks } = tools({}, fake);

    await watchTasks.handler({ task_ids: ["task_1"] });
    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    await watchTasks.handler({ task_ids: ["task_1"], reason: 5 });

    for (const call of fake.watchTasks.mock.calls) {
      expect(call[0]).toMatchObject({ reason: undefined });
    }
  });

  it("rejects a missing, empty, or non-array task_ids without calling the service", async () => {
    const fake = fakeWatchService();
    const { watchTasks } = tools({}, fake);

    for (const input of [{}, { task_ids: [] }, { task_ids: "task_1" }, { task_ids: [1, 2] }]) {
      const result = await watchTasks.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(fake.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a call made outside a session context", async () => {
    const fake = fakeWatchService();
    const { watchTasks } = tools({ sessionId: undefined }, fake);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: expect.stringContaining("session context"),
    });
    expect(fake.watchTasks).not.toHaveBeenCalled();
  });

  it.each([
    [new WatchAuthError("not your task"), "watch_auth"],
    [new WatchValidationError("bad ids"), "watch_validation"],
    [new WatchNotFoundError("no such task"), "watch_not_found"],
    [new Error("pg down"), "watch_error"],
  ])("maps %s to a coded tool error", async (thrown, code) => {
    const fake = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw thrown;
      }),
    });
    const { watchTasks } = tools({}, fake);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: code,
      message: (thrown as Error).message,
    });
  });

  it("stringifies a non-Error throw", async () => {
    const fake = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw "boom";
      }),
    });
    const { watchTasks } = tools({}, fake);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "boom",
    });
  });
});

describe("unwatch handler", () => {
  it("cancels the watch for the calling agent", async () => {
    const fake = fakeWatchService();
    const { unwatch } = tools({}, fake);

    const result = await unwatch.handler({ watch_id: "watch_1" });

    expect(fake.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "watch_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    const fake = fakeWatchService();
    const { unwatch } = tools({}, fake);

    for (const input of [{}, { watch_id: "" }, { watch_id: 3 }]) {
      const result = await unwatch.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(fake.unwatch).not.toHaveBeenCalled();
  });

  it("maps a service throw through the same coded envelope", async () => {
    const fake = fakeWatchService({
      unwatch: vi.fn(async () => {
        throw new WatchNotFoundError("watch_1");
      }),
    });
    const { unwatch } = tools({}, fake);

    const result = await unwatch.handler({ watch_id: "watch_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_not_found",
      message: "task_watch watch_1 not found",
    });
  });
});
