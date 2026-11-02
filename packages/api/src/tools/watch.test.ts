/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters: WatchService owns the auth check, the
 * insert, the already-terminal race and the unwatch state machine. What
 * lives *here* and so is what these tests cover:
 *
 *   - the pre-service validation gates (empty task_ids, missing session
 *     context, blank watch_id),
 *   - argument normalization (mode default, non-string filtering, reason
 *     trimming), and
 *   - the error-class -> error-code mapping in `caughtError`, which is
 *     the agent-visible contract for every way the service can fail.
 *
 * The service is faked, so no DB is required.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Harness {
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  services: { watchService: WatchService };
}

function harness(
  opts: { watchThrows?: unknown; unwatchThrows?: unknown } = {},
): Harness {
  const watchTasks = vi.fn(async () => {
    if (opts.watchThrows !== undefined) throw opts.watchThrows;
    return { watchId: "twh_1", firedImmediately: false };
  });
  const unwatch = vi.fn(async () => {
    if (opts.unwatchThrows !== undefined) throw opts.unwatchThrows;
  });
  return {
    watchTasks,
    unwatch,
    services: { watchService: { watchTasks, unwatch } as unknown as WatchService },
  };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" };

function tools(
  ctx: WatchToolContext = CTX,
  opts: Parameters<typeof harness>[0] = {},
) {
  const h = harness(opts);
  const [watchTool, unwatchTool] = buildWatchTools(ctx, h.services);
  return { ...h, watchTool: watchTool!, unwatchTool: unwatchTool! };
}

describe("buildWatchTools surface", () => {
  it("returns watch_tasks then unwatch, in that order", () => {
    const { watchTool, unwatchTool } = tools();
    expect([watchTool.name, unwatchTool.name]).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares task_ids required and offers both fire modes", () => {
    const { watchTool } = tools();
    expect(watchTool.schema.required).toEqual(["task_ids"]);
    const props = watchTool.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    // The agent branches on these two literals; a silent rename would
    // break every prompt that names them.
    expect(props.mode?.enum).toEqual(expect.arrayContaining(["all", "any"]));
  });

  it("declares watch_id required on unwatch", () => {
    const { unwatchTool } = tools();
    expect(unwatchTool.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks validation", () => {
  it("rejects a missing task_ids", async () => {
    const { watchTool, watchTasks } = tools();
    const res = await watchTool.handler({});
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects an empty task_ids array", async () => {
    const { watchTool, watchTasks } = tools();
    const res = await watchTool.handler({ task_ids: [] });
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a non-array task_ids", async () => {
    const { watchTool, watchTasks } = tools();
    const res = await watchTool.handler({ task_ids: "tsk_1" });
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects an array whose entries are all non-strings", async () => {
    const { watchTool, watchTasks } = tools();
    // Filtered to empty, which is the same dead end as [].
    const res = await watchTool.handler({ task_ids: [1, null, {}] });
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("drops non-string entries but proceeds when at least one survives", async () => {
    const { watchTool, watchTasks } = tools();
    const res = await watchTool.handler({ task_ids: ["tsk_1", 2, null, "tsk_2"] });
    expect(res.isError).toBeFalsy();
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["tsk_1", "tsk_2"] }),
    );
  });

  // Without a session id there is no waiter to resume, so the tool must
  // refuse rather than register a watch that can never wake anyone.
  it("refuses when the caller has no session context", async () => {
    const { watchTool, watchTasks } = tools({ agentId: "agent_a" });
    const res = await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(String(res.content.message)).toContain("session context");
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("checks task_ids before the session context", async () => {
    const { watchTool } = tools({ agentId: "agent_a" });
    const res = await watchTool.handler({ task_ids: [] });
    // Both gates would fire; the array gate is first, so its message wins.
    expect(String(res.content.message)).toContain("task_ids");
  });
});

describe("watch_tasks argument normalization", () => {
  it("defaults mode to all", async () => {
    const { watchTool, watchTasks } = tools();
    await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("passes an explicit any mode through", async () => {
    const { watchTool, watchTasks } = tools();
    await watchTool.handler({ task_ids: ["tsk_1"], mode: "any" });
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "any" }),
    );
  });

  it("falls back to all for an unrecognized mode instead of erroring", async () => {
    const { watchTool, watchTasks } = tools();
    const res = await watchTool.handler({ task_ids: ["tsk_1"], mode: "eventually" });
    expect(res.isError).toBeFalsy();
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("forwards the caller identity from context, not from input", async () => {
    const { watchTool, watchTasks } = tools();
    await watchTool.handler({
      task_ids: ["tsk_1"],
      // A confused (or hostile) caller cannot redirect the watch.
      callerAgentId: "agent_other",
      callerSessionId: "ses_other",
    });
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        callerAgentId: "agent_a",
        callerSessionId: "ses_1",
      }),
    );
  });

  it("trims a reason and forwards it", async () => {
    const { watchTool, watchTasks } = tools();
    await watchTool.handler({ task_ids: ["tsk_1"], reason: "  waiting on CI  " });
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "waiting on CI" }),
    );
  });

  it("omits a blank or non-string reason", async () => {
    const { watchTool, watchTasks } = tools();
    await watchTool.handler({ task_ids: ["tsk_1"], reason: "   " });
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
    await watchTool.handler({ task_ids: ["tsk_1"], reason: 9 });
    expect(watchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });
});

describe("watch_tasks result", () => {
  it("renames the service result to the wire shape", async () => {
    const { watchTool } = tools();
    const res = await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({ watch_id: "twh_1", fired_immediately: false });
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const h = harness();
    h.watchTasks.mockResolvedValueOnce({
      watchId: "twh_hot",
      firedImmediately: true,
    });
    const [watchTool] = buildWatchTools(CTX, h.services);
    const res = await watchTool!.handler({ task_ids: ["tsk_done"] });
    expect(res.content).toEqual({ watch_id: "twh_hot", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("rejects a missing watch_id", async () => {
    const { unwatchTool, unwatch } = tools();
    const res = await unwatchTool.handler({});
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("rejects an empty-string watch_id", async () => {
    const { unwatchTool, unwatch } = tools();
    const res = await unwatchTool.handler({ watch_id: "" });
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("rejects a non-string watch_id", async () => {
    const { unwatchTool, unwatch } = tools();
    const res = await unwatchTool.handler({ watch_id: 1 });
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("delegates with the context agent id and returns ok", async () => {
    const { unwatchTool, unwatch } = tools();
    const res = await unwatchTool.handler({ watch_id: "twh_1" });
    expect(unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "twh_1",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({ ok: true });
  });
});

/**
 * The mapping table. Each service error class has to land on its own
 * agent-visible code — the agent branches on these strings to decide
 * whether to retry, re-read the ids, or give up.
 */
describe("service error mapping", () => {
  it("maps WatchAuthError to watch_auth", async () => {
    const { watchTool } = tools(CTX, {
      watchThrows: new WatchAuthError("task tsk_x is not in your chain"),
    });
    const res = await watchTool.handler({ task_ids: ["tsk_x"] });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_auth",
      message: "task tsk_x is not in your chain",
    });
  });

  it("maps WatchValidationError to watch_validation", async () => {
    const { watchTool } = tools(CTX, {
      watchThrows: new WatchValidationError("too many task ids"),
    });
    const res = await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "too many task ids",
    });
  });

  it("maps WatchNotFoundError to watch_not_found, keeping the id in the message", async () => {
    const { unwatchTool } = tools(CTX, {
      unwatchThrows: new WatchNotFoundError("twh_gone"),
    });
    const res = await unwatchTool.handler({ watch_id: "twh_gone" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_not_found" });
    expect(String(res.content.message)).toContain("twh_gone");
  });

  it("maps a plain Error to the generic watch_error", async () => {
    const { watchTool } = tools(CTX, { watchThrows: new Error("pg down") });
    const res = await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(res.content).toEqual({ error: "watch_error", message: "pg down" });
  });

  it("stringifies a non-Error throw", async () => {
    const { watchTool } = tools(CTX, { watchThrows: "kaboom" });
    const res = await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(res.content).toEqual({ error: "watch_error", message: "kaboom" });
  });

  it("applies the same mapping on the unwatch path", async () => {
    const { unwatchTool } = tools(CTX, {
      unwatchThrows: new WatchAuthError("not yours"),
    });
    const res = await unwatchTool.handler({ watch_id: "twh_1" });
    expect(res.content).toEqual({ error: "watch_auth", message: "not yours" });
  });
});
