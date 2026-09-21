/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check, the insert and the already-terminal race. What this file
 * locks is the adapter's own logic: input coercion (task_ids filtering,
 * mode defaulting, reason trimming), the session-context guard, and the
 * error-class → error-code translation, which is the only place those
 * codes are produced.
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

interface Harness {
  watchTasks: AgentTool;
  unwatch: AgentTool;
  watchCalls: WatchTasksInput[];
  unwatchCalls: Array<{ callerAgentId: string; watchId: string }>;
}

function harness(
  overrides: {
    ctx?: Partial<WatchToolContext>;
    watchTasks?: (input: WatchTasksInput) => Promise<{
      watchId: string;
      firedImmediately: boolean;
    }>;
    unwatch?: () => Promise<void>;
  } = {},
): Harness {
  const watchCalls: WatchTasksInput[] = [];
  const unwatchCalls: Array<{ callerAgentId: string; watchId: string }> = [];

  const watchService = {
    watchTasks: vi.fn(async (input: WatchTasksInput) => {
      watchCalls.push(input);
      if (overrides.watchTasks) return overrides.watchTasks(input);
      return { watchId: "twatch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(
      async (input: { callerAgentId: string; watchId: string }) => {
        unwatchCalls.push(input);
        if (overrides.unwatch) return overrides.unwatch();
      },
    ),
  } as unknown as WatchService;

  const tools = buildWatchTools(
    { agentId: "agent_a", sessionId: "ses_1", ...overrides.ctx },
    { watchService },
  );
  const byName = (n: string): AgentTool => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`tool ${n} not built`);
    return t;
  };
  return {
    watchTasks: byName("watch_tasks"),
    unwatch: byName("unwatch"),
    watchCalls,
    unwatchCalls,
  };
}

describe("buildWatchTools", () => {
  it("builds exactly watch_tasks + unwatch, in that order", () => {
    const tools = buildWatchTools(
      { agentId: "agent_a", sessionId: "ses_1" },
      { watchService: {} as unknown as WatchService },
    );
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares the required input fields on each schema", () => {
    const h = harness();
    expect(h.watchTasks.schema.required).toEqual(["task_ids"]);
    expect(h.unwatch.schema.required).toEqual(["watch_id"]);
  });

  it("enumerates the watch modes on the mode property", () => {
    const h = harness();
    const props = h.watchTasks.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
  });
});

describe("watch_tasks handler", () => {
  it("passes caller identity, ids, mode and reason through to the service", async () => {
    const h = harness();

    const result = await h.watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need both results  ",
    });

    expect(h.watchCalls).toEqual([
      {
        callerAgentId: "agent_a",
        callerSessionId: "ses_1",
        taskIds: ["task_1", "task_2"],
        mode: "any",
        reason: "need both results",
      },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "twatch_1",
      fired_immediately: false,
    });
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const h = harness({
      watchTasks: async () => ({ watchId: "twatch_now", firedImmediately: true }),
    });

    const result = await h.watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "twatch_now",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const h = harness();

    await h.watchTasks.handler({ task_ids: ["task_1"] });
    await h.watchTasks.handler({ task_ids: ["task_1"], mode: "eventually" });
    await h.watchTasks.handler({ task_ids: ["task_1"], mode: 7 });

    expect(h.watchCalls.map((c) => c.mode)).toEqual(["all", "all", "all"]);
  });

  it("drops non-string entries from task_ids", async () => {
    const h = harness();

    await h.watchTasks.handler({ task_ids: ["task_1", 42, null, "task_2"] });

    expect(h.watchCalls[0]?.taskIds).toEqual(["task_1", "task_2"]);
  });

  it("omits reason when blank or not a string", async () => {
    const h = harness();

    await h.watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    await h.watchTasks.handler({ task_ids: ["task_1"], reason: 5 });
    await h.watchTasks.handler({ task_ids: ["task_1"] });

    expect(h.watchCalls.map((c) => c.reason)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("rejects an empty, absent, or all-non-string task_ids without calling the service", async () => {
    const h = harness();

    for (const input of [
      { task_ids: [] },
      {},
      { task_ids: "task_1" },
      { task_ids: [1, 2] },
    ]) {
      const result = await h.watchTasks.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(h.watchCalls).toHaveLength(0);
  });

  it("rejects the call when there is no session context", async () => {
    const h = harness({ ctx: { sessionId: undefined } });

    const result = await h.watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchCalls).toHaveLength(0);
  });

  it("translates each WatchService error class into its own code", async () => {
    const cases: Array<[Error, string]> = [
      [new WatchAuthError("not yours"), "watch_auth"],
      [new WatchValidationError("bad ids"), "watch_validation"],
      [new WatchNotFoundError("twatch_9"), "watch_not_found"],
      [new Error("pool exploded"), "watch_error"],
    ];

    for (const [thrown, code] of cases) {
      const h = harness({
        watchTasks: async () => {
          throw thrown;
        },
      });
      const result = await h.watchTasks.handler({ task_ids: ["task_1"] });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: code,
        message: thrown.message,
      });
    }
  });

  it("stringifies a non-Error throw into the generic watch_error", async () => {
    const h = harness({
      watchTasks: async () => {
        throw "plain string blowup";
      },
    });

    const result = await h.watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "plain string blowup",
    });
  });
});

describe("unwatch handler", () => {
  it("delegates to the service with the caller's agent id", async () => {
    const h = harness();

    const result = await h.unwatch.handler({ watch_id: "twatch_1" });

    expect(h.unwatchCalls).toEqual([
      { callerAgentId: "agent_a", watchId: "twatch_1" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    const h = harness();

    for (const input of [{}, { watch_id: "" }, { watch_id: 12 }]) {
      const result = await h.unwatch.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(h.unwatchCalls).toHaveLength(0);
  });

  it("translates a WatchNotFoundError from the service", async () => {
    const h = harness({
      unwatch: async () => {
        throw new WatchNotFoundError("twatch_gone");
      },
    });

    const result = await h.unwatch.handler({ watch_id: "twatch_gone" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_not_found" });
  });

  it("translates a WatchAuthError from the service", async () => {
    const h = harness({
      unwatch: async () => {
        throw new WatchAuthError("watch belongs to another agent");
      },
    });

    const result = await h.unwatch.handler({ watch_id: "twatch_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_auth" });
  });
});
