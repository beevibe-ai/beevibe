/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService: the service owns auth,
 * the insert, the already-terminal race and the unwatch state machine
 * (all covered by `core/src/services/watch-service.test.ts` against a
 * real Postgres). What lives *here* is the adapter logic — input
 * coercion, the mode default, the session-context guard, and the
 * error-class → error-code mapping — none of which needs a database.
 *
 * The fake service records the input it was handed so the tests can
 * assert on what the adapter actually forwarded, not just on what came
 * back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type UnwatchInput,
  type WatchService,
  type WatchTasksInput,
  type WatchTasksResult,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

class FakeWatchService {
  watchCalls: WatchTasksInput[] = [];
  unwatchCalls: UnwatchInput[] = [];
  /** Set to have the next call throw instead of resolving. */
  throws: unknown = null;
  result: WatchTasksResult = { watchId: "tw_1", firedImmediately: false };

  async watchTasks(input: WatchTasksInput): Promise<WatchTasksResult> {
    this.watchCalls.push(input);
    if (this.throws) throw this.throws;
    return this.result;
  }

  async unwatch(input: UnwatchInput): Promise<void> {
    this.unwatchCalls.push(input);
    if (this.throws) throw this.throws;
  }
}

let fake: FakeWatchService;

function tools(ctx: Partial<WatchToolContext> = {}): {
  watchTasks: AgentTool;
  unwatch: AgentTool;
} {
  const built = buildWatchTools(
    { agentId: "agent_1", sessionId: "ses_1", ...ctx },
    { watchService: fake as unknown as WatchService },
  );
  const byName = Object.fromEntries(built.map((t) => [t.name, t]));
  return {
    watchTasks: byName.watch_tasks!,
    unwatch: byName.unwatch!,
  };
}

beforeEach(() => {
  fake = new FakeWatchService();
});

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const built = buildWatchTools(
      { agentId: "agent_1", sessionId: "ses_1" },
      { watchService: fake as unknown as WatchService },
    );
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both modes in the watch_tasks schema", () => {
    const schema = tools().watchTasks.schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks handler", () => {
  it("forwards ids, mode and reason, and returns the watch id", async () => {
    fake.result = { watchId: "tw_abc", firedImmediately: true };

    const res = await tools().watchTasks.handler({
      task_ids: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "  need the build result  ",
    });

    expect(fake.watchCalls).toEqual([
      {
        callerAgentId: "agent_1",
        callerSessionId: "ses_1",
        taskIds: ["tsk_1", "tsk_2"],
        mode: "any",
        reason: "need the build result",
      },
    ]);
    expect(res).toEqual({
      content: { watch_id: "tw_abc", fired_immediately: true },
    });
  });

  it("defaults mode to 'all' when omitted or unrecognized", async () => {
    await tools().watchTasks.handler({ task_ids: ["tsk_1"] });
    await tools().watchTasks.handler({ task_ids: ["tsk_1"], mode: "either" });
    await tools().watchTasks.handler({ task_ids: ["tsk_1"], mode: 7 });

    expect(fake.watchCalls.map((c) => c.mode)).toEqual(["all", "all", "all"]);
  });

  it("drops a blank reason rather than forwarding an empty string", async () => {
    await tools().watchTasks.handler({ task_ids: ["tsk_1"], reason: "   " });
    await tools().watchTasks.handler({ task_ids: ["tsk_1"], reason: 42 });

    expect(fake.watchCalls.map((c) => c.reason)).toEqual([undefined, undefined]);
  });

  it("filters non-string entries out of task_ids", async () => {
    await tools().watchTasks.handler({
      task_ids: ["tsk_1", 5, null, "tsk_2", { id: "tsk_3" }],
    });

    expect(fake.watchCalls[0]!.taskIds).toEqual(["tsk_1", "tsk_2"]);
  });

  it("rejects task_ids that is missing, not an array, or empty after filtering", async () => {
    for (const input of [
      {},
      { task_ids: "tsk_1" },
      { task_ids: [] },
      { task_ids: [1, 2, 3] },
    ]) {
      const res = await tools().watchTasks.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
    }
    // None of those should have reached the service.
    expect(fake.watchCalls).toEqual([]);
  });

  it("refuses to register a watch outside a session context", async () => {
    const res = await tools({ sessionId: undefined }).watchTasks.handler({
      task_ids: ["tsk_1"],
    });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/session context/);
    expect(fake.watchCalls).toEqual([]);
  });

  it("checks task_ids before the session guard", async () => {
    // Both are invalid; the ids message is the more actionable one.
    const res = await tools({ sessionId: undefined }).watchTasks.handler({});
    expect(res.content.message).toMatch(/non-empty array/);
  });
});

describe("unwatch handler", () => {
  it("forwards the watch id and reports ok", async () => {
    const res = await tools().unwatch.handler({ watch_id: "tw_abc" });

    expect(fake.unwatchCalls).toEqual([
      { callerAgentId: "agent_1", watchId: "tw_abc" },
    ]);
    expect(res).toEqual({ content: { ok: true } });
  });

  it("rejects a missing or non-string watch_id", async () => {
    for (const input of [{}, { watch_id: "" }, { watch_id: 12 }]) {
      const res = await tools().unwatch.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
    }
    expect(fake.unwatchCalls).toEqual([]);
  });
});

describe("error mapping", () => {
  // The agent branches on `error`, so each service error class has to keep
  // landing on its own stable code rather than collapsing to watch_error.
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("bad mode"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("tw_9"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
  ];

  for (const [label, thrown, code] of cases) {
    it(`maps ${label} to ${code} on both tools`, async () => {
      fake.throws = thrown;

      const watched = await tools().watchTasks.handler({ task_ids: ["tsk_1"] });
      expect(watched.isError).toBe(true);
      expect(watched.content.error).toBe(code);
      expect(watched.content.message).toBe((thrown as Error).message);

      const unwatched = await tools().unwatch.handler({ watch_id: "tw_1" });
      expect(unwatched.isError).toBe(true);
      expect(unwatched.content.error).toBe(code);
    });
  }

  it("stringifies a non-Error throw under watch_error", async () => {
    fake.throws = "connection reset";

    const res = await tools().watchTasks.handler({ task_ids: ["tsk_1"] });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_error",
      message: "connection reset",
    });
  });
});
