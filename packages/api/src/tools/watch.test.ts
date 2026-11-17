/**
 * watch_tasks + unwatch MCP tools — unit tests with a fake WatchService.
 *
 * Both tools are thin adapters: the service owns the auth check, the
 * insert, the already-terminal race and the unwatch state machine. What
 * lives *here* is the agent-facing edge — input coercion (task_ids
 * filtering, mode defaulting, reason trimming), the session-context
 * requirement, and the mapping from the service's four error classes
 * onto the stable `error` codes agents branch on. That mapping is the
 * part a refactor can silently break, so it gets a case per class.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

const AGENT_ID = "agent_watcher";
const SESSION_ID = "sess_abcdefghijkl";

interface Harness {
  watchTasks: AgentTool;
  unwatch: AgentTool;
  watchTasksFn: ReturnType<typeof vi.fn>;
  unwatchFn: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    ctx?: Partial<WatchToolContext>;
    watchImpl?: () => unknown;
    unwatchImpl?: () => unknown;
  } = {},
): Harness {
  const watchTasksFn = vi
    .fn()
    .mockImplementation(
      opts.watchImpl ??
        (async () => ({ watchId: "tw_1", firedImmediately: false })),
    );
  const unwatchFn = vi
    .fn()
    .mockImplementation(opts.unwatchImpl ?? (async () => undefined));
  const services = {
    watchService: {
      watchTasks: watchTasksFn,
      unwatch: unwatchFn,
    } as unknown as WatchService,
  };
  const tools = buildWatchTools(
    { agentId: AGENT_ID, sessionId: SESSION_ID, ...opts.ctx },
    services,
  );
  const byName = (n: string): AgentTool => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`no tool named ${n}`);
    return t;
  };
  return {
    watchTasks: byName("watch_tasks"),
    unwatch: byName("unwatch"),
    watchTasksFn,
    unwatchFn,
  };
}

// ── Static surface ───────────────────────────────────────────────────────

describe("buildWatchTools — surface", () => {
  it("returns watch_tasks then unwatch, in that order", () => {
    const services = { watchService: {} as unknown as WatchService };
    const tools = buildWatchTools({ agentId: AGENT_ID }, services);
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both fire modes in the watch_tasks schema", () => {
    const schema = harness().watchTasks.schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

// ── watch_tasks: input coercion ──────────────────────────────────────────

describe("watch_tasks — input coercion", () => {
  it("forwards ids, defaults mode to 'all' and omits an absent reason", async () => {
    const h = harness();
    const res = await h.watchTasks.handler({ task_ids: ["task_a", "task_b"] });
    expect(res.isError).toBeUndefined();
    expect(h.watchTasksFn).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
      taskIds: ["task_a", "task_b"],
      mode: "all",
      reason: undefined,
    });
  });

  it("honors an explicit 'any' mode", async () => {
    const h = harness();
    await h.watchTasks.handler({ task_ids: ["task_a"], mode: "any" });
    expect(h.watchTasksFn.mock.calls[0]?.[0].mode).toBe("any");
  });

  it.each([
    ["an unknown string", "either"],
    ["a non-string", 1],
  ])("falls back to 'all' when mode is %s", async (_label, mode) => {
    const h = harness();
    await h.watchTasks.handler({ task_ids: ["task_a"], mode });
    expect(h.watchTasksFn.mock.calls[0]?.[0].mode).toBe("all");
  });

  it("trims a reason and drops a whitespace-only one", async () => {
    const h = harness();
    await h.watchTasks.handler({ task_ids: ["t"], reason: "  check the build " });
    expect(h.watchTasksFn.mock.calls[0]?.[0].reason).toBe("check the build");

    const h2 = harness();
    await h2.watchTasks.handler({ task_ids: ["t"], reason: "   " });
    expect(h2.watchTasksFn.mock.calls[0]?.[0].reason).toBeUndefined();
  });

  it("drops non-string entries from task_ids rather than forwarding them", async () => {
    const h = harness();
    await h.watchTasks.handler({ task_ids: ["task_a", 7, null, "task_b"] });
    expect(h.watchTasksFn.mock.calls[0]?.[0].taskIds).toEqual([
      "task_a",
      "task_b",
    ]);
  });

  it.each([
    ["an empty array", []],
    ["an array of only non-strings", [1, 2]],
    ["a bare string", "task_a"],
    ["omitted", undefined],
  ])("rejects task_ids given as %s, without calling the service", async (_l, taskIds) => {
    const h = harness();
    const res = await h.watchTasks.handler(
      taskIds === undefined ? {} : { task_ids: taskIds },
    );
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(h.watchTasksFn).not.toHaveBeenCalled();
  });

  it("refuses to register a watch with no session to wake", async () => {
    const h = harness({ ctx: { sessionId: undefined } });
    const res = await h.watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(String(res.content.message)).toContain("session context");
    expect(h.watchTasksFn).not.toHaveBeenCalled();
  });

  it("validates task_ids before the session context", async () => {
    // Both are broken: the agent should hear about the argument it
    // actually passed, not the ambient context.
    const h = harness({ ctx: { sessionId: undefined } });
    const res = await h.watchTasks.handler({ task_ids: [] });
    expect(String(res.content.message)).toContain("non-empty array");
  });
});

// ── watch_tasks: response ────────────────────────────────────────────────

describe("watch_tasks — response", () => {
  it("renames the service result onto the wire contract", async () => {
    const h = harness({
      watchImpl: async () => ({ watchId: "tw_42", firedImmediately: true }),
    });
    const res = await h.watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.content).toEqual({ watch_id: "tw_42", fired_immediately: true });
    expect(res.isError).toBeUndefined();
  });
});

// ── unwatch ──────────────────────────────────────────────────────────────

describe("unwatch", () => {
  it("forwards the watch id scoped to the caller and returns ok", async () => {
    const h = harness();
    const res = await h.unwatch.handler({ watch_id: "tw_1" });
    expect(h.unwatchFn).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "tw_1",
    });
    expect(res.content).toEqual({ ok: true });
    expect(res.isError).toBeUndefined();
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["a non-string", 5],
  ])("rejects a watch_id that is %s", async (_label, watchId) => {
    const h = harness();
    const res = await h.unwatch.handler(
      watchId === undefined ? {} : { watch_id: watchId },
    );
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(h.unwatchFn).not.toHaveBeenCalled();
  });
});

// ── Error mapping (both tools share `caughtError`) ───────────────────────

describe("error mapping", () => {
  const cases: Array<[string, () => never, string, string]> = [
    [
      "WatchAuthError",
      () => {
        throw new WatchAuthError("task task_x is not in your chain");
      },
      "watch_auth",
      "task task_x is not in your chain",
    ],
    [
      "WatchValidationError",
      () => {
        throw new WatchValidationError("task_ids must be non-empty");
      },
      "watch_validation",
      "task_ids must be non-empty",
    ],
    [
      "WatchNotFoundError",
      () => {
        throw new WatchNotFoundError("tw_gone");
      },
      "watch_not_found",
      "task_watch tw_gone not found",
    ],
    [
      "a plain Error",
      () => {
        throw new Error("pool exhausted");
      },
      "watch_error",
      "pool exhausted",
    ],
  ];

  it.each(cases)(
    "watch_tasks maps %s onto %s",
    async (_label, impl, code, message) => {
      const h = harness({ watchImpl: impl });
      const res = await h.watchTasks.handler({ task_ids: ["task_a"] });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message });
    },
  );

  it.each(cases)(
    "unwatch maps %s onto %s",
    async (_label, impl, code, message) => {
      const h = harness({ unwatchImpl: impl });
      const res = await h.unwatch.handler({ watch_id: "tw_1" });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message });
    },
  );

  it("stringifies a non-Error throw", async () => {
    const h = harness({
      watchImpl: () => {
        throw "boom";
      },
    });
    const res = await h.watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.content).toEqual({ error: "watch_error", message: "boom" });
  });
});
