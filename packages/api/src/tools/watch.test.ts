/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService: the service owns the
 * auth check, the insert, the already-terminal race fire and the
 * unwatch state machine. What lives *here* is the input coercion
 * (task_ids filtering, mode defaulting, reason trimming, the
 * session-context guard) and the error-class → error-code mapping. A
 * fake service is enough to pin both.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

function fakeWatchService(overrides: Partial<WatchService> = {}) {
  return {
    watchTasks: vi.fn(async () => ({ watchId: "watch_1", firedImmediately: false })),
    unwatch: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WatchService & {
    watchTasks: ReturnType<typeof vi.fn>;
    unwatch: ReturnType<typeof vi.fn>;
  };
}

const ctx: WatchToolContext = { agentId: "agent_a", sessionId: "sess_a" };

function tools(
  service: ReturnType<typeof fakeWatchService>,
  context: WatchToolContext = ctx,
): Record<string, AgentTool> {
  return Object.fromEntries(
    buildWatchTools(context, { watchService: service }).map((t) => [t.name, t]),
  );
}

describe("buildWatchTools", () => {
  it("returns watch_tasks + unwatch, in that order", () => {
    const names = buildWatchTools(ctx, { watchService: fakeWatchService() }).map(
      (t) => t.name,
    );
    expect(names).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares task_ids required and the mode enum on watch_tasks", () => {
    const { watch_tasks } = tools(fakeWatchService());
    expect(watch_tasks!.schema.required).toEqual(["task_ids"]);
    const props = watch_tasks!.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode!.enum).toEqual(["all", "any"]);
  });
});

describe("watch_tasks handler", () => {
  let service: ReturnType<typeof fakeWatchService>;

  beforeEach(() => {
    service = fakeWatchService();
  });

  it("forwards the caller, task ids and mode, and projects the result", async () => {
    service.watchTasks.mockResolvedValue({
      watchId: "watch_42",
      firedImmediately: true,
    });
    const res = await tools(service).watch_tasks!.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "need both results",
    });

    expect(service.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "sess_a",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need both results",
    } satisfies WatchTasksInput);
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "watch_42", fired_immediately: true });
  });

  it("defaults mode to 'all' when absent or not a known mode", async () => {
    await tools(service).watch_tasks!.handler({ task_ids: ["task_1"] });
    await tools(service).watch_tasks!.handler({
      task_ids: ["task_1"],
      mode: "eventually",
    });
    await tools(service).watch_tasks!.handler({ task_ids: ["task_1"], mode: 7 });

    for (const call of service.watchTasks.mock.calls) {
      expect(call[0].mode).toBe("all");
    }
  });

  it("trims reason and drops it when blank", async () => {
    await tools(service).watch_tasks!.handler({
      task_ids: ["task_1"],
      reason: "  tidy me  ",
    });
    expect(service.watchTasks.mock.calls[0]![0].reason).toBe("tidy me");

    await tools(service).watch_tasks!.handler({ task_ids: ["task_1"], reason: "   " });
    expect(service.watchTasks.mock.calls[1]![0].reason).toBeUndefined();

    await tools(service).watch_tasks!.handler({ task_ids: ["task_1"], reason: 5 });
    expect(service.watchTasks.mock.calls[2]![0].reason).toBeUndefined();
  });

  it("keeps only the string entries of task_ids", async () => {
    await tools(service).watch_tasks!.handler({
      task_ids: ["task_1", 2, null, "task_3", { id: "task_4" }],
    });
    expect(service.watchTasks.mock.calls[0]![0].taskIds).toEqual([
      "task_1",
      "task_3",
    ]);
  });

  it.each([
    ["missing", {}],
    ["empty array", { task_ids: [] }],
    ["non-array", { task_ids: "task_1" }],
    ["all entries non-string", { task_ids: [1, 2] }],
  ])("rejects task_ids that are %s without calling the service", async (_label, input) => {
    const res = await tools(service).watch_tasks!.handler(input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/non-empty array of strings/);
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch outside a session context", async () => {
    const res = await tools(service, { agentId: "agent_a" }).watch_tasks!.handler({
      task_ids: ["task_1"],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it.each([
    [new WatchAuthError("task task_1 is not in your chain"), "watch_auth"],
    [new WatchValidationError("task_ids must be non-empty"), "watch_validation"],
    [new WatchNotFoundError("watch_9"), "watch_not_found"],
    [new Error("pool exhausted"), "watch_error"],
  ])("maps a thrown %s to its error code", async (thrown, code) => {
    service.watchTasks.mockRejectedValue(thrown);
    const res = await tools(service).watch_tasks!.handler({ task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe((thrown as Error).message);
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    service.watchTasks.mockRejectedValue("boom");
    const res = await tools(service).watch_tasks!.handler({ task_ids: ["task_1"] });
    expect(res.content).toEqual({ error: "watch_error", message: "boom" });
  });
});

describe("unwatch handler", () => {
  let service: ReturnType<typeof fakeWatchService>;

  beforeEach(() => {
    service = fakeWatchService();
  });

  it("forwards the watch id and reports ok", async () => {
    const res = await tools(service).unwatch!.handler({ watch_id: "watch_7" });
    expect(service.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "watch_7",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
  });

  it.each([
    ["missing", {}],
    ["empty", { watch_id: "" }],
    ["non-string", { watch_id: 7 }],
  ])("rejects a watch_id that is %s", async (_label, input) => {
    const res = await tools(service).unwatch!.handler(input);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("maps an auth failure from the service", async () => {
    service.unwatch.mockRejectedValue(new WatchAuthError("not your watch"));
    const res = await tools(service).unwatch!.handler({ watch_id: "watch_7" });
    expect(res.content).toEqual({ error: "watch_auth", message: "not your watch" });
  });

  it("maps a not-found failure from the service", async () => {
    service.unwatch.mockRejectedValue(new WatchNotFoundError("watch_7"));
    const res = await tools(service).unwatch!.handler({ watch_id: "watch_7" });
    expect(res.content).toEqual({
      error: "watch_not_found",
      message: "task_watch watch_7 not found",
    });
  });
});
