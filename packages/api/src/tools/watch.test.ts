/**
 * watch_tasks + unwatch — unit tests with vitest fakes (no DB).
 *
 * Both tools are thin adapters over WatchService: the service owns the
 * auth check, the insert and the already-terminal race. What lives *here*
 * is the input coercion (task_ids filtering, mode defaulting, reason
 * trimming), the session-context guard, and the error-class → error-code
 * mapping in `caughtError`. Those are what these tests pin.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

function buildServices(
  overrides: {
    watchTasks?: WatchService["watchTasks"];
    unwatch?: WatchService["unwatch"];
  } = {},
) {
  const watchTasks =
    overrides.watchTasks ??
    vi.fn(async () => ({ watchId: "tw_1", firedImmediately: false }));
  const unwatch = overrides.unwatch ?? vi.fn(async () => undefined);
  const watchService = { watchTasks, unwatch } as unknown as WatchService;
  return { services: { watchService }, watchTasks, unwatch };
}

/** Named lookup that fails loudly — `noUncheckedIndexedAccess` makes a
 *  bare Record index `AgentTool | undefined` at every call site. */
function tools(
  ctx: Partial<WatchToolContext> = {},
  services = buildServices().services,
): { watch_tasks: AgentTool; unwatch: AgentTool } {
  const built = buildWatchTools(
    { agentId: "agent_a", sessionId: "ses_1", ...ctx },
    services,
  );
  const pick = (name: string): AgentTool => {
    const found = built.find((t) => t.name === name);
    if (!found) throw new Error(`tool not assembled: ${name}`);
    return found;
  };
  return { watch_tasks: pick("watch_tasks"), unwatch: pick("unwatch") };
}

/** The `n`th call's first argument, typed. The fakes are declared with the
 *  real service signatures, so the mock surface needs recovering here. */
function firstArg<T>(fn: unknown, n = 0): T {
  const args = (fn as { mock: { calls: unknown[][] } }).mock.calls[n];
  if (!args) throw new Error(`expected at least ${n + 1} call(s)`);
  return args[0] as T;
}

// ── Assembly ─────────────────────────────────────────────────────────────

describe("buildWatchTools", () => {
  it("returns exactly watch_tasks and unwatch, in that order", () => {
    const built = buildWatchTools(
      { agentId: "agent_a", sessionId: "ses_1" },
      buildServices().services,
    );
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both watch modes in the watch_tasks schema", () => {
    const schema = tools().watch_tasks.schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    // The enum is the agent-facing contract — it has to stay in sync with
    // TASK_WATCH_MODES, which is what the handler validates against.
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

// ── watch_tasks ──────────────────────────────────────────────────────────

describe("watch_tasks", () => {
  it("passes task_ids through and defaults mode to 'all'", async () => {
    const { services, watchTasks } = buildServices();
    const res = await tools({}, services).watch_tasks.handler({
      task_ids: ["task_1", "task_2"],
    });

    expect(watchTasks).toHaveBeenCalledTimes(1);
    const arg = firstArg<WatchTasksInput>(watchTasks, 0);
    expect(arg).toEqual({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
    expect(res).toEqual({
      content: { watch_id: "tw_1", fired_immediately: false },
    });
  });

  it("honours an explicit valid mode", async () => {
    const { services, watchTasks } = buildServices();
    await tools({}, services).watch_tasks.handler({
      task_ids: ["task_1"],
      mode: "any",
    });
    expect(firstArg<WatchTasksInput>(watchTasks, 0).mode).toBe("any");
  });

  it("falls back to 'all' for a mode outside TASK_WATCH_MODES", async () => {
    const { services, watchTasks } = buildServices();
    // Unknown modes degrade rather than erroring — the schema already
    // constrains well-behaved clients, and silently widening the watch is
    // safer than refusing to register one.
    await tools({}, services).watch_tasks.handler({
      task_ids: ["task_1"],
      mode: "sometimes",
    });
    expect(firstArg<WatchTasksInput>(watchTasks, 0).mode).toBe("all");
  });

  it("drops non-string entries from task_ids", async () => {
    const { services, watchTasks } = buildServices();
    const res = await tools({}, services).watch_tasks.handler({
      task_ids: ["task_1", 42, null, { id: "task_2" }, "task_3"],
    });
    expect(firstArg<WatchTasksInput>(watchTasks, 0).taskIds).toEqual([
      "task_1",
      "task_3",
    ]);
    expect(res.isError).toBeUndefined();
  });

  it("trims reason and omits it when blank", async () => {
    const { services, watchTasks } = buildServices();
    const t = tools({}, services).watch_tasks;

    await t.handler({ task_ids: ["task_1"], reason: "  need the PR url  " });
    expect(firstArg<WatchTasksInput>(watchTasks, 0).reason).toBe(
      "need the PR url",
    );

    await t.handler({ task_ids: ["task_1"], reason: "   " });
    expect(firstArg<WatchTasksInput>(watchTasks, 1).reason).toBeUndefined();

    await t.handler({ task_ids: ["task_1"], reason: 7 });
    expect(firstArg<WatchTasksInput>(watchTasks, 2).reason).toBeUndefined();
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const { services } = buildServices({
      watchTasks: vi.fn(async () => ({
        watchId: "tw_9",
        firedImmediately: true,
      })) as unknown as WatchService["watchTasks"],
    });
    const res = await tools({}, services).watch_tasks.handler({
      task_ids: ["task_done"],
    });
    expect(res.content).toEqual({ watch_id: "tw_9", fired_immediately: true });
  });

  describe("rejects before touching the service", () => {
    it("when task_ids is missing", async () => {
      const { services, watchTasks } = buildServices();
      const res = await tools({}, services).watch_tasks.handler({});
      expect(res).toEqual({
        content: {
          error: "watch_validation",
          message: "task_ids must be a non-empty array of strings",
        },
        isError: true,
      });
      expect(watchTasks).not.toHaveBeenCalled();
    });

    it("when task_ids is not an array", async () => {
      const { services, watchTasks } = buildServices();
      const res = await tools({}, services).watch_tasks.handler({
        task_ids: "task_1",
      });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
      expect(watchTasks).not.toHaveBeenCalled();
    });

    it("when task_ids holds no strings at all", async () => {
      const { services, watchTasks } = buildServices();
      const res = await tools({}, services).watch_tasks.handler({
        task_ids: [1, 2, 3],
      });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
      expect(watchTasks).not.toHaveBeenCalled();
    });

    it("when there is no session context to identify the waiter", async () => {
      const { services, watchTasks } = buildServices();
      const res = await tools({ sessionId: undefined }, services).watch_tasks.handler(
        { task_ids: ["task_1"] },
      );
      expect(res).toEqual({
        content: {
          error: "watch_validation",
          message: "watch_tasks must be called inside a session context",
        },
        isError: true,
      });
      expect(watchTasks).not.toHaveBeenCalled();
    });
  });
});

// ── unwatch ──────────────────────────────────────────────────────────────

describe("unwatch", () => {
  it("forwards the watch id with the caller agent and returns ok", async () => {
    const { services, unwatch } = buildServices();
    const res = await tools({}, services).unwatch.handler({ watch_id: "tw_1" });
    expect(unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "tw_1",
    });
    expect(res).toEqual({ content: { ok: true } });
  });

  it.each([
    ["missing", {}],
    ["empty string", { watch_id: "" }],
    ["non-string", { watch_id: 12 }],
  ])("rejects a %s watch_id without calling the service", async (_label, input) => {
    const { services, unwatch } = buildServices();
    const res = await tools({}, services).unwatch.handler(input);
    expect(res).toEqual({
      content: {
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      },
      isError: true,
    });
    expect(unwatch).not.toHaveBeenCalled();
  });
});

// ── Error mapping (caughtError) ──────────────────────────────────────────

describe("service error → tool error code", () => {
  // Each WatchService error class maps to a distinct code so the calling
  // agent can branch: auth means stop, validation means fix the args,
  // not_found means the watch is already gone.
  const cases: Array<[string, Error, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("tw_missing"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
  ];

  it.each(cases)("maps %s on watch_tasks", async (_label, err, code) => {
    const { services } = buildServices({
      watchTasks: vi.fn(async () => {
        throw err;
      }) as unknown as WatchService["watchTasks"],
    });
    const res = await tools({}, services).watch_tasks.handler({
      task_ids: ["task_1"],
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe(err.message);
  });

  it.each(cases)("maps %s on unwatch", async (_label, err, code) => {
    const { services } = buildServices({
      unwatch: vi.fn(async () => {
        throw err;
      }) as unknown as WatchService["unwatch"],
    });
    const res = await tools({}, services).unwatch.handler({ watch_id: "tw_1" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
  });

  it("stringifies a non-Error throw rather than leaking undefined", async () => {
    const { services } = buildServices({
      watchTasks: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "boom";
      }) as unknown as WatchService["watchTasks"],
    });
    const res = await tools({}, services).watch_tasks.handler({
      task_ids: ["task_1"],
    });
    expect(res.content).toEqual({ error: "watch_error", message: "boom" });
  });
});
