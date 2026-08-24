/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check, the insert and the already-terminal race. What the adapter
 * owns, and what is locked down here, is: input coercion (mode default,
 * task_ids filtering, reason trimming), the session-context guard, and
 * the mapping from the service's error classes onto stable tool error
 * codes the calling agent branches on.
 *
 * The service is faked, so no Postgres is involved.
 */
import { describe, expect, it, vi } from "vitest";
import { TASK_WATCH_MODES } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Harness {
  services: { watchService: WatchService };
  watchCalls: Record<string, unknown>[];
  unwatchCalls: Record<string, unknown>[];
}

function harness(
  overrides: {
    watchThrows?: unknown;
    unwatchThrows?: unknown;
    result?: { watchId: string; firedImmediately: boolean };
  } = {},
): Harness {
  const watchCalls: Record<string, unknown>[] = [];
  const unwatchCalls: Record<string, unknown>[] = [];

  const watchService = {
    watchTasks: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.watchThrows) throw overrides.watchThrows;
      watchCalls.push(input);
      return overrides.result ?? { watchId: "tw_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.unwatchThrows) throw overrides.unwatchThrows;
      unwatchCalls.push(input);
    }),
  } as unknown as WatchService;

  return { services: { watchService }, watchCalls, unwatchCalls };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function tools(h: Harness, ctx: WatchToolContext = CTX) {
  const [watchTasks, unwatch] = buildWatchTools(ctx, h.services);
  return { watchTasks: watchTasks!, unwatch: unwatch! };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks then unwatch", () => {
    const built = buildWatchTools(CTX, harness().services);
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the domain's mode list in the schema enum", () => {
    const { watchTasks } = tools(harness());
    const props = watchTasks.schema.properties as Record<string, Record<string, unknown>>;

    expect(props.mode?.enum).toEqual([...TASK_WATCH_MODES]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
  });

  it("requires watch_id on unwatch", () => {
    const { unwatch } = tools(harness());
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, task ids and mode to the service", async () => {
    const h = harness();
    const result = await tools(h).watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "waiting on the migration",
    });

    expect(h.watchCalls[0]).toEqual({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "waiting on the migration",
    });
    expect(result.isError).toBeFalsy();
  });

  it("projects the service result onto the wire field names", async () => {
    const h = harness({ result: { watchId: "tw_42", firedImmediately: true } });
    const result = await tools(h).watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "tw_42",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all'", async () => {
    const h = harness();
    await tools(h).watchTasks.handler({ task_ids: ["task_1"] });

    expect(h.watchCalls[0]?.mode).toBe("all");
  });

  it("falls back to 'all' for an unrecognized mode rather than erroring", async () => {
    const h = harness();
    await tools(h).watchTasks.handler({ task_ids: ["task_1"], mode: "either" });

    expect(h.watchCalls[0]?.mode).toBe("all");
  });

  it("accepts every mode the domain declares", async () => {
    for (const mode of TASK_WATCH_MODES) {
      const h = harness();
      await tools(h).watchTasks.handler({ task_ids: ["task_1"], mode });
      expect(h.watchCalls[0]?.mode).toBe(mode);
    }
  });

  it("drops non-string entries from task_ids", async () => {
    const h = harness();
    await tools(h).watchTasks.handler({
      task_ids: ["task_1", 7, null, "task_2", { id: "task_3" }],
    });

    expect(h.watchCalls[0]?.taskIds).toEqual(["task_1", "task_2"]);
  });

  it("trims reason and omits it when blank", async () => {
    const h = harness();
    await tools(h).watchTasks.handler({
      task_ids: ["task_1"],
      reason: "  needs the build  ",
    });
    expect(h.watchCalls[0]?.reason).toBe("needs the build");

    const blank = harness();
    await tools(blank).watchTasks.handler({
      task_ids: ["task_1"],
      reason: "   ",
    });
    expect(blank.watchCalls[0]?.reason).toBeUndefined();

    const nonString = harness();
    await tools(nonString).watchTasks.handler({ task_ids: ["task_1"], reason: 5 });
    expect(nonString.watchCalls[0]?.reason).toBeUndefined();
  });

  it.each([
    ["an empty array", []],
    ["an array with no strings", [1, null, {}]],
    ["a non-array", "task_1"],
    ["omitted", undefined],
  ])("rejects task_ids that is %s without calling the service", async (_l, task_ids) => {
    const h = harness();
    const result = await tools(h).watchTasks.handler({ task_ids });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchCalls).toHaveLength(0);
  });

  // Without a session id the service cannot identify who to wake, so the
  // guard has to fire before the insert rather than writing a dead watch.
  it("refuses when there is no session context", async () => {
    const h = harness();
    const result = await tools(h, { agentId: "agent_a" }).watchTasks.handler({
      task_ids: ["task_1"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchCalls).toHaveLength(0);
  });

  it("checks task_ids before the session guard", async () => {
    const h = harness();
    const result = await tools(h, { agentId: "agent_a" }).watchTasks.handler({
      task_ids: [],
    });

    expect(result.content).toMatchObject({
      message: "task_ids must be a non-empty array of strings",
    });
  });
});

describe("unwatch", () => {
  it("forwards the caller and watch id to the service", async () => {
    const h = harness();
    const result = await tools(h).unwatch.handler({ watch_id: "tw_9" });

    expect(h.unwatchCalls[0]).toEqual({
      callerAgentId: "agent_a",
      watchId: "tw_9",
    });
    expect(result.content).toEqual({ ok: true });
    expect(result.isError).toBeFalsy();
  });

  it("works without a session context — unwatch only needs the agent", async () => {
    const h = harness();
    const result = await tools(h, { agentId: "agent_a" }).unwatch.handler({
      watch_id: "tw_9",
    });

    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 42],
    ["omitted", undefined],
  ])("rejects watch_id that is %s", async (_label, watch_id) => {
    const h = harness();
    const result = await tools(h).unwatch.handler({ watch_id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(h.unwatchCalls).toHaveLength(0);
  });
});

// The agent branches on these codes, so the class → code mapping is the
// contract. Both tools share one `caughtError`, so both are checked.
describe("service error mapping", () => {
  const cases: Array<[string, unknown, string, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth", "not your task"],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
      "task_ids must be non-empty",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("tw_missing"),
      "watch_not_found",
      "task_watch tw_missing not found",
    ],
    ["a plain Error", new Error("connection reset"), "watch_error", "connection reset"],
    ["a thrown string", "boom", "watch_error", "boom"],
  ];

  it.each(cases)("watch_tasks maps %s", async (_label, thrown, code, message) => {
    const h = harness({ watchThrows: thrown });
    const result = await tools(h).watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code, message });
  });

  it.each(cases)("unwatch maps %s", async (_label, thrown, code, message) => {
    const h = harness({ unwatchThrows: thrown });
    const result = await tools(h).unwatch.handler({ watch_id: "tw_9" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code, message });
  });
});
