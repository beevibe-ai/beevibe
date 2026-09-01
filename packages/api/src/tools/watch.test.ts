/**
 * `watch_tasks` / `unwatch` handler tests.
 *
 * Both tools are thin adapters over WatchService, so what's worth
 * pinning is exactly the part the service doesn't do: the input
 * coercion (non-string task ids dropped, unknown modes falling back to
 * 'all', blank reasons normalized away), the missing-session guard, and
 * the mapping of each WatchService error class onto its own stable
 * `error` code — the codes are what an agent branches on, and a
 * mis-mapped one reads as a generic failure.
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

const AGENT = "agent_caller";
const SESSION = "sess_caller";

function harness(ctx: Partial<WatchToolContext> = {}) {
  const watchService = {
    watchTasks: vi.fn().mockResolvedValue({ watchId: "wch_1", firedImmediately: false }),
    unwatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as WatchService;

  const tools = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...ctx },
    { watchService },
  );
  const tool = (name: string): AgentTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no such tool: ${name}`);
    return t;
  };
  return { watchService, tools, tool };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    expect(harness().tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both modes in the watch_tasks schema", () => {
    const schema = harness().tool("watch_tasks").schema as {
      properties: { mode: { enum: string[] } };
    };
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
  });
});

// ── watch_tasks ──────────────────────────────────────────────────────────

describe("watch_tasks", () => {
  it("registers the watch and returns the id plus the fired flag", async () => {
    const h = harness();
    const res = await h.tool("watch_tasks").handler({
      task_ids: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "wch_1", fired_immediately: false });
    expect(h.watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["tsk_1", "tsk_2"],
      mode: "any",
      // Trimmed.
      reason: "need the first result",
    });
  });

  it("passes through fired_immediately when the condition was already met", async () => {
    const h = harness();
    vi.mocked(h.watchService.watchTasks).mockResolvedValue({
      watchId: "wch_2",
      firedImmediately: true,
    });

    const res = await h.tool("watch_tasks").handler({ task_ids: ["tsk_1"] });
    expect(res.content).toEqual({ watch_id: "wch_2", fired_immediately: true });
  });

  it.each([
    ["absent", undefined],
    ["an unknown string", "either"],
    ["not a string", 1],
  ])("defaults mode to 'all' when it is %s", async (_label, mode) => {
    const h = harness();
    await h.tool("watch_tasks").handler({ task_ids: ["tsk_1"], mode });
    expect(h.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["not a string", 5],
  ])("omits the reason when it is %s", async (_label, reason) => {
    const h = harness();
    await h.tool("watch_tasks").handler({ task_ids: ["tsk_1"], reason });
    expect(h.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });

  it("drops non-string entries from task_ids", async () => {
    const h = harness();
    await h.tool("watch_tasks").handler({ task_ids: ["tsk_1", 2, null, "tsk_3"] });
    expect(h.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["tsk_1", "tsk_3"] }),
    );
  });

  it.each([
    ["an empty array", []],
    ["an array with no usable ids", [1, null]],
    ["not an array", "tsk_1"],
    ["absent", undefined],
  ])("rejects task_ids that are %s", async (_label, task_ids) => {
    const h = harness();
    const res = await h.tool("watch_tasks").handler({ task_ids });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toBe("task_ids must be a non-empty array of strings");
    expect(h.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register outside a session context", async () => {
    const h = harness({ sessionId: undefined });
    const res = await h.tool("watch_tasks").handler({ task_ids: ["tsk_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toBe("watch_tasks must be called inside a session context");
    expect(h.watchService.watchTasks).not.toHaveBeenCalled();
  });
});

// ── unwatch ──────────────────────────────────────────────────────────────

describe("unwatch", () => {
  it("cancels the watch and reports ok", async () => {
    const h = harness();
    const res = await h.tool("unwatch").handler({ watch_id: "wch_1" });
    expect(res.content).toEqual({ ok: true });
    expect(h.watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "wch_1",
    });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a string", 7],
  ])("rejects a watch_id that is %s", async (_label, watch_id) => {
    const h = harness();
    const res = await h.tool("unwatch").handler({ watch_id });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(h.watchService.unwatch).not.toHaveBeenCalled();
  });
});

// ── error mapping (shared by both tools) ─────────────────────────────────

describe("WatchService error mapping", () => {
  it.each([
    ["watch_auth", new WatchAuthError("task tsk_1 is not in your conversation chain")],
    ["watch_validation", new WatchValidationError("task_ids must be non-empty")],
    ["watch_not_found", new WatchNotFoundError("wch_gone")],
    ["watch_error", new Error("connection terminated")],
  ])("maps a thrown %s onto its code", async (code, thrown) => {
    const h = harness();
    vi.mocked(h.watchService.watchTasks).mockRejectedValue(thrown);

    const res = await h.tool("watch_tasks").handler({ task_ids: ["tsk_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe((thrown as Error).message);
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    const h = harness();
    vi.mocked(h.watchService.unwatch).mockRejectedValue("pool is draining");

    const res = await h.tool("unwatch").handler({ watch_id: "wch_1" });
    expect(res.content).toEqual({ error: "watch_error", message: "pool is draining" });
  });

  it("maps unwatch's not-found the same way watch_tasks does", async () => {
    const h = harness();
    vi.mocked(h.watchService.unwatch).mockRejectedValue(new WatchNotFoundError("wch_gone"));

    const res = await h.tool("unwatch").handler({ watch_id: "wch_gone" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_not_found");
  });
});
