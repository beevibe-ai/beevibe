/**
 * watch_tasks + unwatch — unit tests with a fake WatchService (no DB).
 *
 * Both tools are thin adapters: the service owns the auth check, the
 * insert, the already-terminal race and the unwatch state machine. So
 * what's worth testing here is exactly the adapter's own work —
 * input coercion (which ids survive, what `mode` defaults to, when a
 * blank `reason` becomes undefined), the two pre-flight guards that
 * never reach the service, and the error taxonomy that turns the
 * service's typed throws into stable `error` codes the agent branches
 * on.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

const AGENT_ID = "agent_caller";
const SESSION_ID = "sess_current";

/**
 * Fake service. `watchTasks` resolves to a fixed result unless a test
 * overrides it; `unwatch` resolves void. Tests assert on the captured
 * call args to prove the adapter forwards what it claims to.
 */
function fakeWatchService(overrides: Partial<WatchService> = {}): WatchService {
  return {
    watchTasks: vi.fn(async () => ({
      watchId: "watch_1",
      firedImmediately: false,
    })),
    unwatch: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WatchService;
}

function tools(
  service: WatchService,
  ctx: Partial<WatchToolContext> = {},
) {
  const all = buildWatchTools(
    { agentId: AGENT_ID, sessionId: SESSION_ID, ...ctx },
    { watchService: service },
  );
  const watchTasks = all.find((t) => t.name === "watch_tasks");
  const unwatch = all.find((t) => t.name === "unwatch");
  if (!watchTasks || !unwatch) throw new Error("tool missing");
  return { all, watchTasks, unwatch };
}

// ── Shape ────────────────────────────────────────────────────────────────

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { all } = tools(fakeWatchService());
    expect(all.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both watch modes in the watch_tasks schema", () => {
    const { watchTasks } = tools(fakeWatchService());
    const props = watchTasks.schema.properties as Record<
      string,
      { enum?: string[] } | undefined
    >;
    // The enum is spread from TASK_WATCH_MODES — if a mode is added to
    // the domain without updating the agent-facing contract, the tool
    // silently stops advertising it.
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });
});

// ── watch_tasks: the happy path + input coercion ─────────────────────────

describe("watch_tasks", () => {
  it("forwards caller identity, ids, mode and reason to the service", async () => {
    const service = fakeWatchService();
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the build result  ",
    });

    expect(service.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
      taskIds: ["task_a", "task_b"],
      mode: "any",
      // Trimmed, not passed through raw.
      reason: "need the build result",
    });
    expect(res.content).toEqual({
      watch_id: "watch_1",
      fired_immediately: false,
    });
    expect(res.isError).toBeUndefined();
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const service = fakeWatchService({
      watchTasks: vi.fn(async () => ({
        watchId: "watch_hot",
        firedImmediately: true,
      })),
    });
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler({ task_ids: ["task_a"] });

    expect(res.content).toEqual({
      watch_id: "watch_hot",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const service = fakeWatchService();
    const { watchTasks } = tools(service);

    await watchTasks.handler({ task_ids: ["task_a"] });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it.each([
    ["an unknown string", "eventually"],
    ["a non-string", 7],
    ["null", null],
  ])("falls back to mode 'all' when mode is %s", async (_label, mode) => {
    const service = fakeWatchService();
    const { watchTasks } = tools(service);

    await watchTasks.handler({ task_ids: ["task_a"], mode });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("drops non-string entries from task_ids rather than passing them on", async () => {
    const service = fakeWatchService();
    const { watchTasks } = tools(service);

    await watchTasks.handler({
      task_ids: ["task_a", 42, null, undefined, { id: "x" }, "task_b"],
    });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_a", "task_b"] }),
    );
  });

  it.each([
    ["whitespace only", "   "],
    ["empty", ""],
    ["a non-string", 12],
  ])("omits reason when it is %s", async (_label, reason) => {
    const service = fakeWatchService();
    const { watchTasks } = tools(service);

    await watchTasks.handler({ task_ids: ["task_a"], reason });

    expect(service.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });
});

// ── watch_tasks: pre-flight guards (never reach the service) ─────────────

describe("watch_tasks guards", () => {
  it.each([
    ["an empty array", []],
    ["an array of only non-strings", [1, null]],
    ["not an array", "task_a"],
    ["missing", undefined],
  ])("rejects task_ids that are %s without calling the service", async (
    _label,
    taskIds,
  ) => {
    const service = fakeWatchService();
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler({ task_ids: taskIds });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/non-empty array of strings/);
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects the call when there is no session context", async () => {
    const service = fakeWatchService();
    // An MCP caller outside a session can't be identified as the waiter.
    const { watchTasks } = tools(service, { sessionId: undefined });

    const res = await watchTasks.handler({ task_ids: ["task_a"] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/inside a session context/);
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("checks task_ids before session context", async () => {
    // Ordering matters for the agent's debugging loop: the more
    // actionable complaint (your ids are empty) should win over the
    // environmental one.
    const { watchTasks } = tools(fakeWatchService(), { sessionId: undefined });

    const res = await watchTasks.handler({ task_ids: [] });

    expect(res.content.message).toMatch(/non-empty array of strings/);
  });
});

// ── Error taxonomy, shared by both tools ─────────────────────────────────

describe("watch tool error mapping", () => {
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("bad ids"),
      "watch_validation",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("no such watch"),
      "watch_not_found",
    ],
    ["a plain Error", new Error("pg exploded"), "watch_error"],
  ];

  it.each(cases)(
    "maps %s thrown by watchTasks to %s",
    async (_label, thrown, code) => {
      const service = fakeWatchService({
        watchTasks: vi.fn(async () => {
          throw thrown;
        }),
      });
      const { watchTasks } = tools(service);

      const res = await watchTasks.handler({ task_ids: ["task_a"] });

      expect(res.isError).toBe(true);
      expect(res.content.error).toBe(code);
      expect(res.content.message).toBe((thrown as Error).message);
    },
  );

  it.each(cases)(
    "maps %s thrown by unwatch to %s",
    async (_label, thrown, code) => {
      const service = fakeWatchService({
        unwatch: vi.fn(async () => {
          throw thrown;
        }),
      });
      const { unwatch } = tools(service);

      const res = await unwatch.handler({ watch_id: "watch_1" });

      expect(res.isError).toBe(true);
      expect(res.content.error).toBe(code);
      expect(res.content.message).toBe((thrown as Error).message);
    },
  );

  it("stringifies a non-Error throw", async () => {
    const service = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw "string failure";
      }),
    });
    const { watchTasks } = tools(service);

    const res = await watchTasks.handler({ task_ids: ["task_a"] });

    expect(res.content).toEqual({
      error: "watch_error",
      message: "string failure",
    });
  });
});

// ── unwatch ──────────────────────────────────────────────────────────────

describe("unwatch", () => {
  it("forwards the watch id with the caller agent and reports ok", async () => {
    const service = fakeWatchService();
    const { unwatch } = tools(service);

    const res = await unwatch.handler({ watch_id: "watch_1" });

    expect(service.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "watch_1",
    });
    expect(res.content).toEqual({ ok: true });
    expect(res.isError).toBeUndefined();
  });

  it("reports ok regardless of the prior watch state (idempotent)", async () => {
    // The service swallows waiting/fired/aborted differences; the tool
    // must not invent a distinction the service doesn't make.
    const service = fakeWatchService({ unwatch: vi.fn(async () => undefined) });
    const { unwatch } = tools(service);

    const first = await unwatch.handler({ watch_id: "watch_1" });
    const second = await unwatch.handler({ watch_id: "watch_1" });

    expect(first.content).toEqual({ ok: true });
    expect(second.content).toEqual({ ok: true });
  });

  it.each([
    ["empty", ""],
    ["a non-string", 9],
    ["missing", undefined],
  ])("rejects a watch_id that is %s without calling the service", async (
    _label,
    watchId,
  ) => {
    const service = fakeWatchService();
    const { unwatch } = tools(service);

    const res = await unwatch.handler({ watch_id: watchId });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/non-empty string/);
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("requires watch_id in its schema", () => {
    const { unwatch } = tools(fakeWatchService());
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});
