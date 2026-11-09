/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check, the insert and the already-terminal race. What the
 * handlers own, and what nothing else re-checks, is the input coercion
 * (task_ids filtering, mode defaulting, reason trimming), the
 * session-context precondition, and the mapping from the service's four
 * error classes onto stable `error` codes the agent branches on. A fake
 * service covers all of it.
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

const AGENT_ID = "agent_team";
const SESSION_ID = "ses_caller";

interface Harness {
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  calls: WatchTasksInput[];
  tools: ReturnType<typeof buildWatchTools>;
}

function harness(
  opts: { ctx?: Partial<WatchToolContext>; watchError?: unknown; unwatchError?: unknown } = {},
): Harness {
  const calls: WatchTasksInput[] = [];
  const watchTasks = vi.fn(async (input: WatchTasksInput) => {
    if (opts.watchError) throw opts.watchError;
    calls.push(input);
    return { watchId: "tw_minted", firedImmediately: false };
  });
  const unwatch = vi.fn(async () => {
    if (opts.unwatchError) throw opts.unwatchError;
  });
  const watchService = { watchTasks, unwatch } as unknown as WatchService;

  const ctx: WatchToolContext = {
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    ...opts.ctx,
  };
  return { watchTasks, unwatch, calls, tools: buildWatchTools(ctx, { watchService }) };
}

function watchTool(h: Harness) {
  const t = h.tools.find((x) => x.name === "watch_tasks");
  if (!t) throw new Error("watch_tasks not assembled");
  return t;
}

function unwatchTool(h: Harness) {
  const t = h.tools.find((x) => x.name === "unwatch");
  if (!t) throw new Error("unwatch not assembled");
  return t;
}

describe("buildWatchTools", () => {
  it("assembles exactly watch_tasks + unwatch", () => {
    expect(harness().tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both modes in the watch_tasks schema enum", () => {
    const schema = watchTool(harness()).schema as {
      required: string[];
      properties: { mode: { enum: string[] } };
    };
    expect(schema.required).toEqual(["task_ids"]);
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
  });
});

describe("watch_tasks — input coercion", () => {
  it("forwards task_ids, mode and reason to the service with the caller identity", async () => {
    const h = harness();
    const result = await watchTool(h).handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need both results before I plan  ",
    });

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need both results before I plan",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "tw_minted", fired_immediately: false });
  });

  it("defaults mode to 'all' when absent or not a recognized mode", async () => {
    for (const mode of [undefined, "ANY", "either", 1, null]) {
      const h = harness();
      await watchTool(h).handler({ task_ids: ["task_a"], mode });
      expect(h.calls[0]?.mode).toBe("all");
    }
  });

  it("drops a blank or non-string reason rather than passing an empty string", async () => {
    for (const reason of [undefined, "", "   ", 5]) {
      const h = harness();
      await watchTool(h).handler({ task_ids: ["task_a"], reason });
      expect(h.calls[0]?.reason).toBeUndefined();
    }
  });

  it("filters non-string entries out of task_ids", async () => {
    const h = harness();
    await watchTool(h).handler({ task_ids: ["task_a", 7, null, "task_b", { id: "x" }] });
    expect(h.calls[0]?.taskIds).toEqual(["task_a", "task_b"]);
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const h = harness();
    h.watchTasks.mockResolvedValue({ watchId: "tw_now", firedImmediately: true });
    const result = await watchTool(h).handler({ task_ids: ["task_done"] });
    expect(result.content).toEqual({ watch_id: "tw_now", fired_immediately: true });
  });
});

describe("watch_tasks — preconditions", () => {
  it("rejects task_ids that is missing, not an array, or empty", async () => {
    for (const task_ids of [undefined, "task_a", [], 3, {}]) {
      const h = harness();
      const result = await watchTool(h).handler({ task_ids });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(h.watchTasks).not.toHaveBeenCalled();
    }
  });

  it("rejects task_ids whose entries are all non-strings", async () => {
    const h = harness();
    const result = await watchTool(h).handler({ task_ids: [1, 2, null] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch with no session to wake", async () => {
    const h = harness({ ctx: { sessionId: undefined } });
    const result = await watchTool(h).handler({ task_ids: ["task_a"] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchTasks).not.toHaveBeenCalled();
  });
});

describe("watch_tasks — service error mapping", () => {
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("task not in your chain"), "watch_auth"],
    ["WatchValidationError", new WatchValidationError("empty"), "watch_validation"],
    ["WatchNotFoundError", new WatchNotFoundError("tw_1"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
  ];

  for (const [label, thrown, code] of cases) {
    it(`maps ${label} to ${code} and keeps the message`, async () => {
      const h = harness({ watchError: thrown });
      const result = await watchTool(h).handler({ task_ids: ["task_a"] });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: code,
        message: (thrown as Error).message,
      });
    });
  }

  it("stringifies a non-Error throw under watch_error", async () => {
    const h = harness({ watchError: "exploded" });
    const result = await watchTool(h).handler({ task_ids: ["task_a"] });
    expect(result.content).toMatchObject({ error: "watch_error", message: "exploded" });
  });
});

describe("unwatch", () => {
  it("cancels the named watch for the calling agent", async () => {
    const h = harness();
    const result = await unwatchTool(h).handler({ watch_id: "tw_1" });
    expect(h.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    for (const watch_id of [undefined, "", 12, null]) {
      const h = harness();
      const result = await unwatchTool(h).handler({ watch_id });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
      expect(h.unwatch).not.toHaveBeenCalled();
    }
  });

  it("maps service errors through the same code table as watch_tasks", async () => {
    const h = harness({ unwatchError: new WatchAuthError("not yours") });
    const result = await unwatchTool(h).handler({ watch_id: "tw_1" });
    expect(result.content).toMatchObject({ error: "watch_auth", message: "not yours" });

    const h2 = harness({ unwatchError: new WatchNotFoundError("tw_404") });
    const r2 = await unwatchTool(h2).handler({ watch_id: "tw_404" });
    expect(r2.content).toMatchObject({ error: "watch_not_found" });

    const h3 = harness({ unwatchError: 404 });
    const r3 = await unwatchTool(h3).handler({ watch_id: "tw_1" });
    expect(r3.content).toMatchObject({ error: "watch_error", message: "404" });
  });

  it("is documented as idempotent — the agent may call it after a fire", () => {
    expect(unwatchTool(harness()).description).toContain("Idempotent");
  });
});
