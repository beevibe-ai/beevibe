/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService — the service does the
 * auth check, the insert and the already-terminal race. What lives here
 * is the adapter's own share: argument coercion, the session-context
 * guard, the agent-facing wire shape, and the mapping from each
 * WatchService error class onto a stable error code the agent branches
 * on. A fake service keeps Postgres out of it.
 */
import { describe, expect, it, vi } from "vitest";
import { TASK_WATCH_MODES } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
  type WatchTasksResult,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

function harness(
  opts: { watchThrows?: unknown; unwatchThrows?: unknown; result?: WatchTasksResult } = {},
) {
  const watchCalls: WatchTasksInput[] = [];
  const unwatchCalls: { callerAgentId: string; watchId: string }[] = [];
  const watchService = {
    watchTasks: vi.fn(async (input: WatchTasksInput) => {
      if (opts.watchThrows) throw opts.watchThrows;
      watchCalls.push(input);
      return opts.result ?? { watchId: "watch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: { callerAgentId: string; watchId: string }) => {
      if (opts.unwatchThrows) throw opts.unwatchThrows;
      unwatchCalls.push(input);
    }),
  } as unknown as WatchService;
  return { watchService, watchCalls, unwatchCalls };
}

const CTX: WatchToolContext = { agentId: "agent_lead", sessionId: "sess_now" };

function tools(h: ReturnType<typeof harness>, ctx: WatchToolContext = CTX) {
  const [watchTasks, unwatch] = buildWatchTools(ctx, {
    watchService: h.watchService,
  });
  return { watchTasks: watchTasks!, unwatch: unwatch! };
}

describe("buildWatchTools surface", () => {
  it("returns watch_tasks then unwatch, in that order", () => {
    const built = buildWatchTools(CTX, harness());
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the mode enum from the domain constant, not a literal", () => {
    const { watchTasks } = tools(harness());
    const props = watchTasks.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode?.enum).toEqual([...TASK_WATCH_MODES]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    expect(props.task_ids).toMatchObject({ type: "array", minItems: 1 });
  });

  it("documents both fire conditions in the agent-facing description", () => {
    const { watchTasks, unwatch } = tools(harness());
    expect(watchTasks.description).toContain("terminal status");
    expect(watchTasks.description).toContain("FIRST task");
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks argument handling", () => {
  it("forwards task ids, mode and reason with the caller's agent + session", async () => {
    const h = harness();
    const res = await tools(h).watchTasks.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the first result  ",
    });
    expect(h.watchCalls[0]).toEqual({
      callerAgentId: "agent_lead",
      callerSessionId: "sess_now",
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });
    expect(res.isError).toBeFalsy();
  });

  it("defaults mode to all", async () => {
    const h = harness();
    await tools(h).watchTasks.handler({ task_ids: ["task_a"] });
    expect(h.watchCalls[0]?.mode).toBe("all");
  });

  it.each(["every", "", "ANY", 1, null])(
    "falls back to all for an unrecognized mode (%p)",
    async (mode) => {
      const h = harness();
      await tools(h).watchTasks.handler({ task_ids: ["task_a"], mode });
      expect(h.watchCalls[0]?.mode).toBe("all");
    },
  );

  it("drops non-string entries from task_ids", async () => {
    const h = harness();
    await tools(h).watchTasks.handler({
      task_ids: ["task_a", 42, null, "task_b", { id: "task_c" }],
    });
    expect(h.watchCalls[0]?.taskIds).toEqual(["task_a", "task_b"]);
  });

  it.each([
    ["an empty array", []],
    ["an array with no strings", [1, 2]],
    ["a bare string", "task_a"],
    ["missing", undefined],
  ])("rejects task_ids that are %s", async (_label, taskIds) => {
    const h = harness();
    const res = await tools(h).watchTasks.handler({ task_ids: taskIds });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(h.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it.each([["   "], [""], [7], [null]])(
    "omits reason rather than sending %p",
    async (reason) => {
      const h = harness();
      await tools(h).watchTasks.handler({ task_ids: ["task_a"], reason });
      expect(h.watchCalls[0]?.reason).toBeUndefined();
    },
  );

  it("refuses to register a watch outside a session context", async () => {
    const h = harness();
    const res = await tools(h, { agentId: "agent_lead" }).watchTasks.handler({
      task_ids: ["task_a"],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(h.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("checks task_ids before the session guard", async () => {
    // Both are wrong; the agent should hear about the ids first since
    // that is the argument it controls.
    const h = harness();
    const res = await tools(h, { agentId: "agent_lead" }).watchTasks.handler({
      task_ids: [],
    });
    expect(res.content.message).toContain("task_ids");
  });
});

describe("watch_tasks result projection", () => {
  it("renames the service result onto the snake_case wire shape", async () => {
    const h = harness({ result: { watchId: "watch_xyz", firedImmediately: true } });
    const res = await tools(h).watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.content).toEqual({
      watch_id: "watch_xyz",
      fired_immediately: true,
    });
    expect(res.isError).toBeFalsy();
  });

  it("reports fired_immediately false for a watch that is still waiting", async () => {
    const h = harness({ result: { watchId: "watch_w", firedImmediately: false } });
    const res = await tools(h).watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.content.fired_immediately).toBe(false);
  });
});

describe("unwatch", () => {
  it("forwards the watch id with the caller's agent id", async () => {
    const h = harness();
    const res = await tools(h).unwatch.handler({ watch_id: "watch_1" });
    expect(h.unwatchCalls[0]).toEqual({
      callerAgentId: "agent_lead",
      watchId: "watch_1",
    });
    expect(res.content).toEqual({ ok: true });
    expect(res.isError).toBeFalsy();
  });

  it("works without a session context — only the agent id is needed", async () => {
    const h = harness();
    const res = await tools(h, { agentId: "agent_lead" }).unwatch.handler({
      watch_id: "watch_1",
    });
    expect(res.content).toEqual({ ok: true });
  });

  it.each([["missing", undefined], ["empty", ""], ["non-string", 9]])(
    "rejects a %s watch_id",
    async (_label, watchId) => {
      const h = harness();
      const res = await tools(h).unwatch.handler({ watch_id: watchId });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
      expect(h.watchService.unwatch).not.toHaveBeenCalled();
    },
  );

  it("still reports ok for an already-fired watch — the service is idempotent", async () => {
    const h = harness();
    const res = await tools(h).unwatch.handler({ watch_id: "watch_fired" });
    expect(res.content).toEqual({ ok: true });
  });
});

describe("error code mapping", () => {
  const cases: [string, unknown, string][] = [
    ["WatchAuthError", new WatchAuthError("task task_a is not yours"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must reference existing tasks"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("watch_9"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
    ["a non-Error throw", "pg_notify failed", "watch_error"],
  ];

  it.each(cases)("maps %s thrown by watchTasks to %s", async (_l, thrown, code) => {
    const h = harness({ watchThrows: thrown });
    const res = await tools(h).watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(typeof res.content.message).toBe("string");
    expect(res.content.message).not.toBe("");
  });

  it.each(cases)("maps %s thrown by unwatch to %s", async (_l, thrown, code) => {
    const h = harness({ unwatchThrows: thrown });
    const res = await tools(h).unwatch.handler({ watch_id: "watch_1" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
  });

  it("carries the service's own message through rather than a generic one", async () => {
    const h = harness({ watchThrows: new WatchAuthError("task task_a is not yours") });
    const res = await tools(h).watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.content.message).toBe("task task_a is not yours");
  });

  it("names the missing id in a not-found message", async () => {
    const h = harness({ unwatchThrows: new WatchNotFoundError("watch_9") });
    const res = await tools(h).unwatch.handler({ watch_id: "watch_9" });
    expect(res.content.message).toContain("watch_9");
  });
});
