/**
 * watch_tasks + unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check, the insert and the already-terminal race. What lives here
 * is the adapter's own logic: input coercion, the mode default, the
 * session-context requirement, and the mapping of each service error
 * class onto a stable `error` code the agent can branch on.
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
  watch: ReturnType<typeof buildWatchTools>[number];
  unwatchTool: ReturnType<typeof buildWatchTools>[number];
}

function build(
  ctx: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" },
  behavior: { watchThrows?: unknown; unwatchThrows?: unknown } = {},
): Harness {
  const watchTasks = vi.fn(async () => {
    if (behavior.watchThrows) throw behavior.watchThrows;
    return { watchId: "twt_1", firedImmediately: false };
  });
  const unwatch = vi.fn(async () => {
    if (behavior.unwatchThrows) throw behavior.unwatchThrows;
  });
  const watchService = { watchTasks, unwatch } as unknown as WatchService;
  const [watch, unwatchTool] = buildWatchTools(ctx, { watchService });
  return { watchTasks, unwatch, watch: watch!, unwatchTool: unwatchTool! };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watch, unwatchTool } = build();
    expect(watch.name).toBe("watch_tasks");
    expect(unwatchTool.name).toBe("unwatch");
  });

  it("declares the required fields on each schema", () => {
    const { watch, unwatchTool } = build();
    expect(watch.schema.required).toEqual(["task_ids"]);
    expect(unwatchTool.schema.required).toEqual(["watch_id"]);
  });

  it("enumerates the real watch modes in the schema", () => {
    const { watch } = build();
    const props = watch.schema.properties as { mode: { enum: string[] } };
    expect(props.mode.enum).toEqual(expect.arrayContaining(["all", "any"]));
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const { watch, watchTasks } = build();
    const result = await watch.handler({
      task_ids: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "twt_1", fired_immediately: false });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    for (const mode of [undefined, "either", 3, null]) {
      const { watch, watchTasks } = build();
      await watch.handler({ task_ids: ["tsk_1"], mode });
      expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
    }
  });

  it("drops a blank reason instead of forwarding an empty string", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["tsk_1"], reason: "   " });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({ reason: undefined });
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["tsk_1", 2, null, "tsk_3"] });
    expect(watchTasks.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["tsk_1", "tsk_3"],
    });
  });

  it.each([
    ["absent", undefined],
    ["not an array", "tsk_1"],
    ["empty", []],
    ["all non-strings", [1, 2]],
  ])("rejects task_ids when %s, without calling the service", async (_l, task_ids) => {
    const { watch, watchTasks } = build();
    const result = await watch.handler({ task_ids });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch outside a session context", async () => {
    const { watch, watchTasks } = build({ agentId: "agent_a" });
    const result = await watch.handler({ task_ids: ["tsk_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: expect.stringContaining("session context"),
    });
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const { watch, watchTasks } = build();
    watchTasks.mockResolvedValueOnce({ watchId: "twt_9", firedImmediately: true });
    const result = await watch.handler({ task_ids: ["tsk_done"] });

    expect(result.content).toEqual({ watch_id: "twt_9", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("forwards the caller and watch id", async () => {
    const { unwatchTool, unwatch } = build();
    const result = await unwatchTool.handler({ watch_id: "twt_1" });

    expect(unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "twt_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a string", 5],
  ])("rejects watch_id when %s, without calling the service", async (_l, watch_id) => {
    const { unwatchTool, unwatch } = build();
    const result = await unwatchTool.handler({ watch_id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("works without a session id — unwatch only needs the agent", async () => {
    const { unwatchTool, unwatch } = build({ agentId: "agent_a" });
    const result = await unwatchTool.handler({ watch_id: "twt_1" });

    expect(result.content).toEqual({ ok: true });
    expect(unwatch).toHaveBeenCalledOnce();
  });
});

describe("service error mapping", () => {
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    ["WatchValidationError", new WatchValidationError("bad ids"), "watch_validation"],
    ["WatchNotFoundError", new WatchNotFoundError("no such watch"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
    ["a non-Error throw", "kaboom", "watch_error"],
  ];

  it.each(cases)("watch_tasks maps %s to %s", async (_label, thrown, code) => {
    const { watch } = build(undefined, { watchThrows: thrown });
    const result = await watch.handler({ task_ids: ["tsk_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
    expect(typeof result.content.message).toBe("string");
  });

  it.each(cases)("unwatch maps %s to %s", async (_label, thrown, code) => {
    const { unwatchTool } = build(undefined, { unwatchThrows: thrown });
    const result = await unwatchTool.handler({ watch_id: "twt_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });

  it("keeps the service's message on a mapped error", async () => {
    const { watch } = build(undefined, {
      watchThrows: new WatchAuthError("task tsk_x is not in your conversation chain"),
    });
    const result = await watch.handler({ task_ids: ["tsk_x"] });

    expect(result.content.message).toBe(
      "task tsk_x is not in your conversation chain",
    );
  });
});
