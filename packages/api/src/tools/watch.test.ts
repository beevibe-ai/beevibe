/**
 * `watch_tasks` + `unwatch` — the MCP adapters over WatchService.
 *
 * The service owns the auth check, the insert, the already-terminal
 * race and the unwatch state machine; those are covered by its own
 * DB-backed suite. What lives *here* is the adapter layer, and it is
 * the part an agent actually collides with: input coercion (task_ids
 * arriving as junk, an unknown mode), the session-context guard, and
 * the mapping from each typed service error onto the stable `error`
 * code agents branch on. All of it runs against a fake service, so
 * this suite needs no database.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type UnwatchInput,
  type WatchService,
  type WatchTasksInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

const AGENT = "agent_lead";
const SESSION = "sess_abc123abc123";

type ServiceOverrides = Partial<Record<"watchTasks" | "unwatch", unknown>>;

/**
 * Builds the two tools over a fake WatchService. `watchTasksFn` /
 * `unwatchFn` are the spies on the service; `watch` / `unwatch` are the
 * tools themselves — kept under distinct names so a destructure can
 * reach both at once.
 */
function makeTools(ctx: Partial<WatchToolContext> = {}, overrides: ServiceOverrides = {}) {
  // Typed params so `mock.calls[i][0]` stays a real WatchTasksInput
  // rather than an empty tuple.
  const watchTasksFn = vi.fn(async (_input: WatchTasksInput) => ({
    watchId: "twch_1",
    firedImmediately: false,
  }));
  const unwatchFn = vi.fn(async (_input: UnwatchInput) => undefined);
  const service = {
    watchTasks: overrides.watchTasks ?? watchTasksFn,
    unwatch: overrides.unwatch ?? unwatchFn,
  } as unknown as WatchService;

  const tools = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...ctx },
    { watchService: service },
  );
  const byName = (n: string) => tools.find((t) => t.name === n)!;
  return {
    tools,
    watch: byName("watch_tasks"),
    unwatch: byName("unwatch"),
    watchTasksFn,
    unwatchFn,
  };
}

describe("buildWatchTools surface", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { tools } = makeTools();
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both fire modes and requires task_ids", () => {
    const { watch } = makeTools();
    const props = watch.schema.properties as Record<string, Record<string, unknown>>;
    expect(props.mode!.enum).toEqual(["all", "any"]);
    expect(watch.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("passes the caller identity, ids, mode and reason to the service", async () => {
    const { watch, watchTasksFn } = makeTools();
    const result = await watch.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(watchTasksFn).toHaveBeenCalledTimes(1);
    expect(watchTasksFn.mock.calls[0]![0]).toEqual({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "twch_1", fired_immediately: false });
  });

  it("defaults to mode 'all' when mode is missing or not a known mode", async () => {
    const { watch, watchTasksFn } = makeTools();
    for (const mode of [undefined, "ALL", "first", 1, null]) {
      await watch.handler({ task_ids: ["task_1"], mode });
    }
    for (const call of watchTasksFn.mock.calls) {
      expect(call[0].mode).toBe("all");
    }
  });

  it("drops a blank reason rather than sending whitespace into the wake intent", async () => {
    const { watch, watchTasksFn } = makeTools();
    for (const reason of [undefined, "", "   ", 42]) {
      await watch.handler({ task_ids: ["task_1"], reason });
    }
    for (const call of watchTasksFn.mock.calls) {
      expect(call[0].reason).toBeUndefined();
    }
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watch, watchTasksFn } = makeTools();
    await watch.handler({ task_ids: ["task_1", 7, null, "task_2", { id: "x" }] });
    expect(watchTasksFn.mock.calls[0]![0].taskIds).toEqual([
      "task_1",
      "task_2",
    ]);
  });

  it("rejects task_ids that are absent, not an array, or empty after filtering", async () => {
    const { watch, watchTasksFn } = makeTools();
    for (const task_ids of [undefined, "task_1", [], [1, 2], {}]) {
      const result = await watch.handler({ task_ids });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(watchTasksFn).not.toHaveBeenCalled();
  });

  it("refuses to register outside a session context — there'd be no waiter to wake", async () => {
    const { watch, watchTasksFn } = makeTools({ sessionId: undefined });
    const result = await watch.handler({ task_ids: ["task_1"] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchTasksFn).not.toHaveBeenCalled();
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const { watch } = makeTools(
      {},
      { watchTasks: vi.fn(async () => ({ watchId: "twch_2", firedImmediately: true })) },
    );
    const result = await watch.handler({ task_ids: ["task_done"] });
    expect(result.content).toEqual({ watch_id: "twch_2", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("forwards the caller agent and watch id to the service", async () => {
    const { unwatch: tool, unwatchFn } = makeTools();
    const result = await tool.handler({ watch_id: "twch_1" });
    expect(unwatchFn).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "twch_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    const { unwatch: tool, unwatchFn } = makeTools();
    for (const watch_id of [undefined, "", 42, null, {}]) {
      const result = await tool.handler({ watch_id });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(unwatchFn).not.toHaveBeenCalled();
  });
});

/**
 * The error-code mapping is the wire contract: agents branch on
 * `error`, so a typed service error must never degrade to the generic
 * code. Both tools share `caughtError`, so both are driven off the
 * same table.
 */
describe("service error mapping", () => {
  const CASES: ReadonlyArray<[label: string, thrown: unknown, code: string]> = [
    ["auth", new WatchAuthError("task not in your chain"), "watch_auth"],
    ["validation", new WatchValidationError("too many tasks"), "watch_validation"],
    ["not found", new WatchNotFoundError("twch_9"), "watch_not_found"],
    ["plain Error", new Error("pool exhausted"), "watch_error"],
    ["non-Error throw", "kaboom", "watch_error"],
  ];

  for (const [label, thrown, code] of CASES) {
    it(`maps a ${label} failure from watch_tasks to ${code}`, async () => {
      const { watch } = makeTools(
        {},
        {
          watchTasks: vi.fn(async () => {
            throw thrown;
          }),
        },
      );
      const result = await watch.handler({ task_ids: ["task_1"] });
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(code);
      expect(result.content.message).toBeTruthy();
    });

    it(`maps a ${label} failure from unwatch to ${code}`, async () => {
      const { unwatch: tool } = makeTools(
        {},
        {
          unwatch: vi.fn(async () => {
            throw thrown;
          }),
        },
      );
      const result = await tool.handler({ watch_id: "twch_1" });
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(code);
    });
  }

  it("keeps the service's message so the transcript says why", async () => {
    const { watch } = makeTools(
      {},
      {
        watchTasks: vi.fn(async () => {
          throw new WatchAuthError("task_9 does not belong to your conversation chain");
        }),
      },
    );
    const result = await watch.handler({ task_ids: ["task_9"] });
    expect(result.content.message).toBe(
      "task_9 does not belong to your conversation chain",
    );
  });
});
