/**
 * watch_tasks + unwatch tool adapters — vitest fakes, no DB.
 *
 * `WatchService` owns the real state machine and is tested against
 * Postgres in core. What lives *here* is the adapter layer, and its
 * whole job is input coercion and error mapping: silently dropping a
 * non-string out of `task_ids`, defaulting an unknown `mode` to "all"
 * rather than passing it through, and translating each typed service
 * error into the `error` code an agent branches on. Those are the paths
 * covered below.
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

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function makeService(): WatchService {
  return {
    watchTasks: vi.fn(async () => ({ watchId: "watch_1", firedImmediately: false })),
    unwatch: vi.fn(async () => undefined),
  } as unknown as WatchService;
}

function build(ctx: WatchToolContext = CTX, watchService: WatchService = makeService()) {
  const tools = buildWatchTools(ctx, { watchService });
  const byName = (name: string): AgentTool => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not built`);
    return tool;
  };
  return { tools, watchService, watchTasks: byName("watch_tasks"), unwatch: byName("unwatch") };
}

describe("buildWatchTools", () => {
  it("builds both tools with input schemas that require their key field", () => {
    const { tools, watchTasks, unwatch } = build();

    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
    expect(watchTasks.schema).toMatchObject({ required: ["task_ids"] });
    expect(unwatch.schema).toMatchObject({ required: ["watch_id"] });
    // The mode enum is the agent-facing contract; it must track the domain.
    expect((watchTasks.schema.properties as Record<string, { enum?: string[] }>).mode?.enum).toEqual(
      ["all", "any"],
    );
  });
});

describe("watch_tasks", () => {
  it("registers a watch and returns the id plus the fired flag", async () => {
    const { watchTasks, watchService } = build();
    vi.mocked(watchService.watchTasks).mockResolvedValue({
      watchId: "watch_9",
      firedImmediately: true,
    });

    const res = await watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "watch_9", fired_immediately: true });
    expect(watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      // Trimmed — it lands in the wake intent the agent reads back.
      reason: "need the first result",
    });
  });

  it("defaults mode to 'all'", async () => {
    const { watchTasks, watchService } = build();
    await watchTasks.handler({ task_ids: ["task_1"] });

    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("falls back to 'all' rather than forwarding an unknown mode", async () => {
    const { watchTasks, watchService } = build();
    await watchTasks.handler({ task_ids: ["task_1"], mode: "either" });

    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["a non-string", 7],
  ])("omits reason when it is %s", async (_label, reason) => {
    const { watchTasks, watchService } = build();
    await watchTasks.handler({ task_ids: ["task_1"], ...(reason === undefined ? {} : { reason }) });

    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });

  it("drops non-string entries from task_ids", async () => {
    const { watchTasks, watchService } = build();
    await watchTasks.handler({ task_ids: ["task_1", 42, null, "task_2"] });

    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_1", "task_2"] }),
    );
  });

  it.each([
    ["an empty array", []],
    ["a non-array", "task_1"],
    ["an array with no strings left after filtering", [1, 2]],
    ["an absent field", undefined],
  ])("rejects %s without calling the service", async (_label, task_ids) => {
    const { watchTasks, watchService } = build();
    const res = await watchTasks.handler(task_ids === undefined ? {} : { task_ids });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a call made outside a session context", async () => {
    // No sessionId means no waiter to resume — the service could not
    // identify who to wake.
    const { watchTasks, watchService } = build({ agentId: "agent_a" });
    const res = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "watch_validation" });
    expect(res.content.message).toContain("session context");
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it.each([
    [new WatchAuthError("not your task"), "watch_auth", "not your task"],
    [new WatchValidationError("task_ids must be non-empty"), "watch_validation", "task_ids must be non-empty"],
    [new WatchNotFoundError("watch_x"), "watch_not_found", "task_watch watch_x not found"],
    [new Error("pg down"), "watch_error", "pg down"],
    ["a bare string throw", "watch_error", "a bare string throw"],
  ])("maps a thrown %s to its tool error code", async (thrown, code, message) => {
    const { watchTasks, watchService } = build();
    vi.mocked(watchService.watchTasks).mockRejectedValue(thrown);

    const res = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message });
  });
});

describe("unwatch", () => {
  it("cancels the watch scoped to the calling agent", async () => {
    const { unwatch, watchService } = build();
    const res = await unwatch.handler({ watch_id: "watch_1" });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "watch_1",
    });
  });

  it.each([
    ["an absent watch_id", {}],
    ["an empty watch_id", { watch_id: "" }],
    ["a non-string watch_id", { watch_id: 12 }],
  ])("rejects %s without calling the service", async (_label, input) => {
    const { unwatch, watchService } = build();
    const res = await unwatch.handler(input);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });

  it.each([
    [new WatchAuthError("watch does not belong to caller"), "watch_auth"],
    [new WatchNotFoundError("watch_x"), "watch_not_found"],
    [new WatchValidationError("cannot unwatch a watch that already fired"), "watch_validation"],
    [new Error("pg down"), "watch_error"],
  ])("maps a thrown %s to its tool error code", async (thrown, code) => {
    const { unwatch, watchService } = build();
    vi.mocked(watchService.unwatch).mockRejectedValue(thrown);

    const res = await unwatch.handler({ watch_id: "watch_1" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
  });
});
