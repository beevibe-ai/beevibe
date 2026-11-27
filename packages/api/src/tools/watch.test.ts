/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check, the insert, the already-terminal race fire and the
 * unwatch state machine, and is covered against real Postgres in
 * `core/src/services/watch-service.test.ts`.
 *
 * What lives *only* here, and so is what's tested:
 *   - the pre-service input gates (empty task_ids, missing session ctx)
 *   - mode defaulting + rejection of unknown modes
 *   - reason normalization
 *   - the snake_case response projection the agent actually reads
 *   - the thrown-error → stable error-code mapping, which is how an
 *     agent distinguishes "not yours" from "already gone"
 */

import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
  type WatchTasksResult,
  type UnwatchInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

const AGENT_ID = "agent_caller";
const SESSION_ID = "sess_caller";

interface Harness {
  tools: ReturnType<typeof buildWatchTools>;
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    ctx?: Partial<WatchToolContext>;
    result?: WatchTasksResult;
    watchError?: unknown;
    unwatchError?: unknown;
  } = {},
): Harness {
  const watchTasks = vi.fn(async (_input: WatchTasksInput) => {
    if ("watchError" in opts) throw opts.watchError;
    return opts.result ?? { watchId: "twatch_1", firedImmediately: false };
  });
  const unwatch = vi.fn(async (_input: UnwatchInput) => {
    if ("unwatchError" in opts) throw opts.unwatchError;
  });

  const services = {
    watchService: { watchTasks, unwatch } as unknown as WatchService,
  };
  const ctx: WatchToolContext = {
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    ...opts.ctx,
  };
  return { tools: buildWatchTools(ctx, services), watchTasks, unwatch };
}

function watchTasksTool(h: Harness) {
  const t = h.tools.find((x) => x.name === "watch_tasks");
  if (!t) throw new Error("watch_tasks tool missing");
  return t;
}

function unwatchTool(h: Harness) {
  const t = h.tools.find((x) => x.name === "unwatch");
  if (!t) throw new Error("unwatch tool missing");
  return t;
}

describe("buildWatchTools — surface", () => {
  it("returns watch_tasks then unwatch", () => {
    expect(harness().tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the three real fire modes on watch_tasks", () => {
    const schema = watchTasksTool(harness()).schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    // Only task_ids is required — mode defaults, reason is a note.
    expect(schema.required).toEqual(["task_ids"]);
    expect(schema.properties.mode.enum).toContain("all");
    expect(schema.properties.mode.enum).toContain("any");
  });

  it("requires watch_id on unwatch", () => {
    const schema = unwatchTool(harness()).schema as { required: string[] };
    expect(schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks — input gates", () => {
  it.each([
    ["absent", undefined],
    ["an empty array", []],
    ["not an array", "task_1"],
    ["an array with no strings", [1, null, {}]],
  ])("rejects task_ids that are %s without calling the service", async (_l, taskIds) => {
    const h = harness();
    const res = await watchTasksTool(h).handler({ task_ids: taskIds });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("keeps only the string entries of a mixed task_ids array", async () => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_1", 7, null, "task_2"] });
    expect(h.watchTasks.mock.calls[0]![0].taskIds).toEqual(["task_1", "task_2"]);
  });

  // Without a session id the service cannot identify the waiter, so the
  // watch would fire into nothing. Fail loudly instead of inserting it.
  it("refuses to register a watch outside a session context", async () => {
    const h = harness({ ctx: { sessionId: undefined } });
    const res = await watchTasksTool(h).handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/session context/);
    expect(h.watchTasks).not.toHaveBeenCalled();
  });
});

describe("watch_tasks — request mapping", () => {
  it("forwards caller identity from ctx, not from input", async () => {
    const h = harness();
    // An agent must not be able to register a watch as somebody else.
    await watchTasksTool(h).handler({
      task_ids: ["task_1"],
      callerAgentId: "agent_someone_else",
      callerSessionId: "sess_other",
    });
    expect(h.watchTasks.mock.calls[0]![0]).toMatchObject({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
    });
  });

  it("defaults mode to 'all'", async () => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_1"] });
    expect(h.watchTasks.mock.calls[0]![0].mode).toBe("all");
  });

  it("passes a valid mode through", async () => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_1"], mode: "any" });
    expect(h.watchTasks.mock.calls[0]![0].mode).toBe("any");
  });

  it.each([
    ["an unknown string", "first"],
    ["wrong case", "ALL"],
    ["a non-string", 1],
  ])("falls back to 'all' when mode is %s", async (_l, mode) => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_1"], mode });
    expect(h.watchTasks.mock.calls[0]![0].mode).toBe("all");
  });

  it("trims a reason", async () => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_1"], reason: "  waiting on docs  " });
    expect(h.watchTasks.mock.calls[0]![0].reason).toBe("waiting on docs");
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["a non-string", 5],
  ])("omits a reason that is %s", async (_l, reason) => {
    const h = harness();
    await watchTasksTool(h).handler({ task_ids: ["task_1"], reason });
    expect(h.watchTasks.mock.calls[0]![0].reason).toBeUndefined();
  });
});

describe("watch_tasks — response projection", () => {
  it("projects the service result to the snake_case wire shape", async () => {
    const h = harness({ result: { watchId: "twatch_42", firedImmediately: false } });
    const res = await watchTasksTool(h).handler({ task_ids: ["task_1"] });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "twatch_42", fired_immediately: false });
  });

  // The already-terminal race: the tasks finished before the watch was
  // registered, so the next session spawns synchronously. The agent
  // branches on this, so it has to survive the projection.
  it("surfaces fired_immediately when the condition was already met", async () => {
    const h = harness({ result: { watchId: "twatch_43", firedImmediately: true } });
    const res = await watchTasksTool(h).handler({ task_ids: ["task_1"], mode: "any" });
    expect(res.content).toEqual({ watch_id: "twatch_43", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("cancels by id and reports ok", async () => {
    const h = harness();
    const res = await unwatchTool(h).handler({ watch_id: "twatch_1" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(h.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "twatch_1",
    });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["a non-string", 9],
  ])("rejects a watch_id that is %s without calling the service", async (_l, watchId) => {
    const h = harness();
    const res = await unwatchTool(h).handler({ watch_id: watchId });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(h.unwatch).not.toHaveBeenCalled();
  });

  it("is idempotent from the tool's side — ok regardless of prior state", async () => {
    // The service swallows already-fired/aborted; the tool must not
    // invent a failure on top of that.
    const h = harness();
    await unwatchTool(h).handler({ watch_id: "twatch_1" });
    const second = await unwatchTool(h).handler({ watch_id: "twatch_1" });
    expect(second.content).toEqual({ ok: true });
  });
});

// Error codes are the agent's branch points: watch_auth means "not
// yours, don't retry", watch_not_found means "already gone, move on",
// watch_error means "unexpected". Collapsing these would strand agents.
describe("error-code mapping", () => {
  const cases: Array<[string, unknown, string, string]> = [
    ["WatchAuthError", new WatchAuthError("task not in your chain"), "watch_auth", "task not in your chain"],
    [
      "WatchValidationError",
      new WatchValidationError("mode unsupported"),
      "watch_validation",
      "mode unsupported",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("twatch_9"), "watch_not_found", "task_watch twatch_9 not found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error", "pool exhausted"],
    ["a non-Error throw", "raw failure", "watch_error", "raw failure"],
  ];

  it.each(cases)("maps %s from watch_tasks", async (_l, thrown, code, message) => {
    const h = harness({ watchError: thrown });
    const res = await watchTasksTool(h).handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe(message);
  });

  it.each(cases)("maps %s from unwatch", async (_l, thrown, code, message) => {
    const h = harness({ unwatchError: thrown });
    const res = await unwatchTool(h).handler({ watch_id: "twatch_1" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe(message);
  });
});
