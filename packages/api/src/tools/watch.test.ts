/**
 * watch_tasks + unwatch MCP tool tests.
 *
 * Both tools are thin adapters over WatchService: they normalize the
 * agent-supplied JSON (which arrives untyped over MCP), reject what the
 * service would reject anyway, and map the service's typed errors onto
 * the stable tool-error codes agents branch on. The service itself is a
 * fake here — these tests are about the adapter layer, not the watch
 * state machine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_WATCH_MODES } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

let watchTasks: ReturnType<typeof vi.fn>;
let unwatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  watchTasks = vi
    .fn()
    .mockResolvedValue({ watchId: "watch_1", firedImmediately: false });
  unwatch = vi.fn().mockResolvedValue(undefined);
});

function build(ctx: Partial<WatchToolContext> = {}): {
  watchTool: AgentTool;
  unwatchTool: AgentTool;
} {
  const service = { watchTasks, unwatch } as unknown as WatchService;
  const tools = buildWatchTools(
    { agentId: "agent_caller", sessionId: "sess_caller", ...ctx },
    { watchService: service },
  );
  const watchTool = tools.find((t) => t.name === "watch_tasks")!;
  const unwatchTool = tools.find((t) => t.name === "unwatch")!;
  return { watchTool, unwatchTool };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const service = { watchTasks, unwatch } as unknown as WatchService;
    const tools = buildWatchTools(
      { agentId: "agent_caller", sessionId: "sess_caller" },
      { watchService: service },
    );
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the real mode enum, so the schema can't drift from the domain", () => {
    const { watchTool } = build();
    const props = watchTool.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode!.enum).toEqual([...TASK_WATCH_MODES]);
    expect(watchTool.schema.required).toEqual(["task_ids"]);
    expect(props.task_ids!.minItems).toBe(1);
  });

  it("requires watch_id on unwatch", () => {
    const { unwatchTool } = build();
    expect(unwatchTool.schema.required).toEqual(["watch_id"]);
  });

  it("gives both tools a non-empty agent-facing description", () => {
    const { watchTool, unwatchTool } = build();
    expect(watchTool.description).toMatch(/watch/i);
    expect(watchTool.description.length).toBeGreaterThan(50);
    expect(unwatchTool.description).toMatch(/idempotent/i);
  });
});

describe("watch_tasks handler", () => {
  it("passes the caller, ids, mode and reason through to the service", async () => {
    const { watchTool } = build();
    const out = await watchTool.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_caller",
      callerSessionId: "sess_caller",
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });
    expect(out).toEqual({
      content: { watch_id: "watch_1", fired_immediately: false },
    });
    expect(out.isError).toBeUndefined();
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    watchTasks.mockResolvedValue({ watchId: "watch_2", firedImmediately: true });
    const { watchTool } = build();
    const out = await watchTool.handler({ task_ids: ["task_a"] });
    expect(out.content).toEqual({
      watch_id: "watch_2",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const { watchTool } = build();
    await watchTool.handler({ task_ids: ["task_a"] });
    expect(watchTasks.mock.calls[0]![0]).toMatchObject({ mode: "all" });
  });

  it("defaults mode to 'all' when the agent sends an unknown mode", async () => {
    const { watchTool } = build();
    await watchTool.handler({ task_ids: ["task_a"], mode: "eventually" });
    expect(watchTasks.mock.calls[0]![0]).toMatchObject({ mode: "all" });
  });

  it("defaults mode to 'all' when mode is not a string", async () => {
    const { watchTool } = build();
    await watchTool.handler({ task_ids: ["task_a"], mode: 7 });
    expect(watchTasks.mock.calls[0]![0]).toMatchObject({ mode: "all" });
  });

  it("accepts every documented mode", async () => {
    const { watchTool } = build();
    for (const mode of TASK_WATCH_MODES) {
      watchTasks.mockClear();
      await watchTool.handler({ task_ids: ["task_a"], mode });
      expect(watchTasks.mock.calls[0]![0]).toMatchObject({ mode });
    }
  });

  it("drops non-string entries from task_ids rather than forwarding them", async () => {
    const { watchTool } = build();
    await watchTool.handler({ task_ids: ["task_a", 42, null, "task_b", {}] });
    expect(watchTasks.mock.calls[0]![0]).toMatchObject({
      taskIds: ["task_a", "task_b"],
    });
  });

  it("rejects a missing task_ids without calling the service", async () => {
    const { watchTool } = build();
    const out = await watchTool.handler({});
    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("watch_validation");
    expect(out.content.message).toMatch(/non-empty array of strings/);
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects a non-array task_ids", async () => {
    const { watchTool } = build();
    const out = await watchTool.handler({ task_ids: "task_a" });
    expect(out.content.error).toBe("watch_validation");
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("rejects an array that has no usable string ids", async () => {
    const { watchTool } = build();
    const out = await watchTool.handler({ task_ids: [1, 2, null] });
    expect(out.content.error).toBe("watch_validation");
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("treats a blank reason as absent", async () => {
    const { watchTool } = build();
    await watchTool.handler({ task_ids: ["task_a"], reason: "   " });
    expect(watchTasks.mock.calls[0]![0].reason).toBeUndefined();
  });

  it("treats a non-string reason as absent", async () => {
    const { watchTool } = build();
    await watchTool.handler({ task_ids: ["task_a"], reason: 99 });
    expect(watchTasks.mock.calls[0]![0].reason).toBeUndefined();
  });

  it("errors when called outside a session — there is no waiter to wake", async () => {
    const { watchTool } = build({ sessionId: undefined });
    const out = await watchTool.handler({ task_ids: ["task_a"] });
    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("watch_validation");
    expect(out.content.message).toMatch(/inside a session context/);
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("validates task_ids before the session context", async () => {
    // Ordering matters for the agent's error message: a caller with both
    // problems should hear about the argument it controls.
    const { watchTool } = build({ sessionId: undefined });
    const out = await watchTool.handler({ task_ids: [] });
    expect(out.content.message).toMatch(/non-empty array of strings/);
  });
});

describe("watch_tasks error mapping", () => {
  const cases: ReadonlyArray<[string, Error, string]> = [
    ["auth", new WatchAuthError("not your task"), "watch_auth"],
    ["validation", new WatchValidationError("too many tasks"), "watch_validation"],
    ["not-found", new WatchNotFoundError("watch_9"), "watch_not_found"],
    ["generic", new Error("db exploded"), "watch_error"],
  ];

  for (const [label, err, code] of cases) {
    it(`maps a ${label} failure onto ${code}`, async () => {
      watchTasks.mockRejectedValue(err);
      const { watchTool } = build();
      const out = await watchTool.handler({ task_ids: ["task_a"] });
      expect(out.isError).toBe(true);
      expect(out.content.error).toBe(code);
      expect(out.content.message).toBe(err.message);
    });
  }

  it("stringifies a non-Error throw instead of leaking undefined", async () => {
    watchTasks.mockRejectedValue("just a string");
    const { watchTool } = build();
    const out = await watchTool.handler({ task_ids: ["task_a"] });
    expect(out.content).toEqual({
      error: "watch_error",
      message: "just a string",
    });
    expect(out.isError).toBe(true);
  });
});

describe("unwatch handler", () => {
  it("cancels the watch for the calling agent", async () => {
    const { unwatchTool } = build();
    const out = await unwatchTool.handler({ watch_id: "watch_1" });
    expect(unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_caller",
      watchId: "watch_1",
    });
    expect(out).toEqual({ content: { ok: true } });
    expect(out.isError).toBeUndefined();
  });

  it("rejects a missing watch_id without calling the service", async () => {
    const { unwatchTool } = build();
    const out = await unwatchTool.handler({});
    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("watch_validation");
    expect(out.content.message).toMatch(/non-empty string/);
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("rejects an empty-string watch_id", async () => {
    const { unwatchTool } = build();
    const out = await unwatchTool.handler({ watch_id: "" });
    expect(out.content.error).toBe("watch_validation");
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("rejects a non-string watch_id", async () => {
    const { unwatchTool } = build();
    const out = await unwatchTool.handler({ watch_id: { id: "watch_1" } });
    expect(out.content.error).toBe("watch_validation");
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("maps a not-found watch onto watch_not_found", async () => {
    unwatch.mockRejectedValue(new WatchNotFoundError("watch_9"));
    const { unwatchTool } = build();
    const out = await unwatchTool.handler({ watch_id: "watch_9" });
    expect(out.content.error).toBe("watch_not_found");
    expect(out.content.message).toMatch(/watch_9 not found/);
  });

  it("maps someone else's watch onto watch_auth", async () => {
    unwatch.mockRejectedValue(new WatchAuthError("watch does not belong to caller"));
    const { unwatchTool } = build();
    const out = await unwatchTool.handler({ watch_id: "watch_1" });
    expect(out.content.error).toBe("watch_auth");
  });

  it("maps an already-fired watch onto watch_validation", async () => {
    unwatch.mockRejectedValue(new WatchValidationError("watch already fired"));
    const { unwatchTool } = build();
    const out = await unwatchTool.handler({ watch_id: "watch_1" });
    expect(out.content.error).toBe("watch_validation");
  });

  it("maps an unexpected failure onto watch_error", async () => {
    unwatch.mockRejectedValue(new Error("db exploded"));
    const { unwatchTool } = build();
    const out = await unwatchTool.handler({ watch_id: "watch_1" });
    expect(out.content.error).toBe("watch_error");
    expect(out.content.message).toBe("db exploded");
  });
});
