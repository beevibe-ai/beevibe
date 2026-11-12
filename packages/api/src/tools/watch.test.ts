/**
 * watch_tasks + unwatch MCP tools — unit tests with vitest fakes (no DB).
 *
 * Both handlers are thin adapters over WatchService, so what's worth
 * pinning here is the part that *isn't* delegation: the input coercion
 * before the call (task_ids filtered to strings, mode defaulted, blank
 * reason dropped to undefined), the missing-session guard, and the
 * error-class → error-code mapping that agents branch on.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
  type WatchTasksResult,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "sess_caller001" };

function makeService(
  overrides: Partial<{
    watchTasks: WatchService["watchTasks"];
    unwatch: WatchService["unwatch"];
  }> = {},
): WatchService {
  return {
    watchTasks:
      overrides.watchTasks ??
      vi.fn(async (_input: WatchTasksInput) => ({
        watchId: "twatch_1",
        firedImmediately: false,
      })),
    unwatch: overrides.unwatch ?? vi.fn(async () => undefined),
  } as unknown as WatchService;
}

function tools(service: WatchService, ctx: WatchToolContext = CTX) {
  const [watchTasks, unwatch] = buildWatchTools(ctx, { watchService: service });
  return { watchTasks: watchTasks!, unwatch: unwatch! };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const built = buildWatchTools(CTX, { watchService: makeService() });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both fire modes in the watch_tasks schema", () => {
    const { watchTasks } = tools(makeService());
    const schema = watchTasks.schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

// ── watch_tasks ──────────────────────────────────────────────────────────

describe("watch_tasks handler", () => {
  it("passes the caller context through and returns the service's ids", async () => {
    const watchTasksFn = vi.fn(
      async (_input: WatchTasksInput): Promise<WatchTasksResult> => ({
        watchId: "twatch_7",
        firedImmediately: true,
      }),
    );
    const { watchTasks } = tools(makeService({ watchTasks: watchTasksFn }));

    const result = await watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "need the migration result",
    });

    expect(watchTasksFn).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "sess_caller001",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need the migration result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "twatch_7",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const watchTasksFn = vi.fn(
      async (_input: WatchTasksInput): Promise<WatchTasksResult> => ({
        watchId: "twatch_1",
        firedImmediately: false,
      }),
    );
    const { watchTasks } = tools(makeService({ watchTasks: watchTasksFn }));

    await watchTasks.handler({ task_ids: ["task_1"] });

    expect(watchTasksFn.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("defaults mode to 'all' when the value isn't a known mode", async () => {
    const watchTasksFn = vi.fn(
      async (_input: WatchTasksInput): Promise<WatchTasksResult> => ({
        watchId: "twatch_1",
        firedImmediately: false,
      }),
    );
    const { watchTasks } = tools(makeService({ watchTasks: watchTasksFn }));

    await watchTasks.handler({ task_ids: ["task_1"], mode: "eventually" });

    expect(watchTasksFn.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
  });

  it("drops non-string entries out of task_ids", async () => {
    const watchTasksFn = vi.fn(
      async (_input: WatchTasksInput): Promise<WatchTasksResult> => ({
        watchId: "twatch_1",
        firedImmediately: false,
      }),
    );
    const { watchTasks } = tools(makeService({ watchTasks: watchTasksFn }));

    await watchTasks.handler({ task_ids: ["task_1", 42, null, "task_2"] });

    expect(watchTasksFn.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["task_1", "task_2"],
    });
  });

  it("trims reason and drops a whitespace-only one to undefined", async () => {
    const watchTasksFn = vi.fn(
      async (_input: WatchTasksInput): Promise<WatchTasksResult> => ({
        watchId: "twatch_1",
        firedImmediately: false,
      }),
    );
    const service = makeService({ watchTasks: watchTasksFn });
    const { watchTasks } = tools(service);

    await watchTasks.handler({ task_ids: ["task_1"], reason: "  check CI  " });
    expect(watchTasksFn.mock.calls[0]?.[0]).toMatchObject({ reason: "check CI" });

    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    expect(watchTasksFn.mock.calls[1]?.[0]).toMatchObject({ reason: undefined });

    await watchTasks.handler({ task_ids: ["task_1"], reason: 7 });
    expect(watchTasksFn.mock.calls[2]?.[0]).toMatchObject({ reason: undefined });
  });

  it("rejects a missing task_ids without calling the service", async () => {
    const watchTasksFn = vi.fn();
    const { watchTasks } = tools(
      makeService({ watchTasks: watchTasksFn as unknown as WatchService["watchTasks"] }),
    );

    const result = await watchTasks.handler({});

    expect(watchTasksFn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
  });

  it("rejects task_ids that filters down to empty", async () => {
    const { watchTasks } = tools(makeService());
    const result = await watchTasks.handler({ task_ids: [1, 2, 3] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
  });

  it("rejects a non-array task_ids", async () => {
    const { watchTasks } = tools(makeService());
    const result = await watchTasks.handler({ task_ids: "task_1" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
  });

  it("refuses to register a watch outside a session context", async () => {
    const watchTasksFn = vi.fn();
    const { watchTasks } = tools(
      makeService({ watchTasks: watchTasksFn as unknown as WatchService["watchTasks"] }),
      { agentId: "agent_a" },
    );

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(watchTasksFn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
  });
});

// ── error mapping (shared by both tools via caughtError) ─────────────────

describe("watch tool error mapping", () => {
  it.each([
    ["watch_auth", new WatchAuthError("task_9 is not in your chain")],
    ["watch_validation", new WatchValidationError("mode must be all or any")],
    ["watch_not_found", new WatchNotFoundError("twatch_9")],
    ["watch_error", new Error("postgres connection reset")],
  ])("maps a thrown %s to its code", async (code, thrown) => {
    const { watchTasks } = tools(
      makeService({
        watchTasks: vi.fn(async () => {
          throw thrown;
        }),
      }),
    );

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code, message: thrown.message });
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    const { watchTasks } = tools(
      makeService({
        watchTasks: vi.fn(async () => {
          throw "boom";
        }),
      }),
    );

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toMatchObject({ error: "watch_error", message: "boom" });
  });
});

// ── unwatch ──────────────────────────────────────────────────────────────

describe("unwatch handler", () => {
  it("delegates to the service and returns ok", async () => {
    const unwatchFn = vi.fn(async () => undefined);
    const { unwatch } = tools(makeService({ unwatch: unwatchFn }));

    const result = await unwatch.handler({ watch_id: "twatch_3" });

    expect(unwatchFn).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "twatch_3",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing watch_id without calling the service", async () => {
    const unwatchFn = vi.fn();
    const { unwatch } = tools(
      makeService({ unwatch: unwatchFn as unknown as WatchService["unwatch"] }),
    );

    const result = await unwatch.handler({});

    expect(unwatchFn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
  });

  it("rejects an empty-string and a non-string watch_id", async () => {
    const { unwatch } = tools(makeService());
    expect((await unwatch.handler({ watch_id: "" })).isError).toBe(true);
    expect((await unwatch.handler({ watch_id: 12 })).isError).toBe(true);
  });

  it("maps a WatchNotFoundError from the service to watch_not_found", async () => {
    const { unwatch } = tools(
      makeService({
        unwatch: vi.fn(async () => {
          throw new WatchNotFoundError("twatch_404");
        }),
      }),
    );

    const result = await unwatch.handler({ watch_id: "twatch_404" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_not_found" });
  });

  it("maps an already-fired unwatch (validation) to watch_validation", async () => {
    const { unwatch } = tools(
      makeService({
        unwatch: vi.fn(async () => {
          throw new WatchValidationError("cannot unwatch a watch that already fired");
        }),
      }),
    );

    const result = await unwatch.handler({ watch_id: "twatch_5" });

    expect(result.content).toMatchObject({ error: "watch_validation" });
  });
});
