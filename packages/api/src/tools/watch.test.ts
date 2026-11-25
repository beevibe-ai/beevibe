/**
 * Tests for the `watch_tasks` + `unwatch` MCP tools.
 *
 * Both are thin adapters over WatchService, so what's worth testing is
 * exactly the adapter layer: input coercion (task_ids filtering, mode
 * defaulting, reason trimming), the session-context precondition, and
 * the error taxonomy that maps each WatchService error class onto a
 * stable `error` code the calling agent branches on.
 *
 * The service itself is a vitest fake — its own behaviour (the auth
 * check, the already-terminal race fire, the unwatch state machine) is
 * covered by `watch-service.test.ts` against a real database.
 */
import { describe, it, expect, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

const AGENT = "agt_caller";
const SESSION = "sess_caller0001";

function build(ctx: Partial<WatchToolContext> = {}) {
  const watchTasks = vi.fn().mockResolvedValue({
    watchId: "twch_1",
    firedImmediately: false,
  });
  const unwatch = vi.fn().mockResolvedValue(undefined);
  const tools = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...ctx },
    { watchService: { watchTasks, unwatch } as never },
  );
  const byName = (name: string): AgentTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not built`);
    return t;
  };
  return {
    tools,
    watchTasks,
    unwatch,
    watch: byName("watch_tasks"),
    unwatchTool: byName("unwatch"),
  };
}

describe("buildWatchTools", () => {
  it("builds watch_tasks and unwatch, in that order", () => {
    const { tools } = build();
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both fire modes in the watch_tasks schema", () => {
    const { watch } = build();
    const props = watch.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watch.schema.required).toEqual(["task_ids"]);
  });

  it("requires watch_id on unwatch", () => {
    const { unwatchTool } = build();
    expect(unwatchTool.schema.required).toEqual(["watch_id"]);
  });

  it("documents the one-shot contract in the descriptions", () => {
    const { watch, unwatchTool } = build();
    expect(watch.description).toContain("one-shot");
    expect(unwatchTool.description).toContain("Idempotent");
  });
});

describe("watch_tasks handler", () => {
  it("registers a watch and returns the wire shape", async () => {
    const { watch, watchTasks } = build();
    watchTasks.mockResolvedValue({ watchId: "twch_7", firedImmediately: true });
    const res = await watch.handler({ task_ids: ["task_a", "task_b"], mode: "any" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "twch_7", fired_immediately: true });
    expect(watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: undefined,
    });
  });

  it("defaults mode to 'all' when none is given", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["task_a"] });
    expect(watchTasks).toHaveBeenCalledWith(expect.objectContaining({ mode: "all" }));
  });

  it("defaults mode to 'all' when the given mode is not a known mode", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["task_a"], mode: "eventually" });
    expect(watchTasks).toHaveBeenCalledWith(expect.objectContaining({ mode: "all" }));
  });

  it("defaults mode to 'all' when the given mode is not a string", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["task_a"], mode: 1 });
    expect(watchTasks).toHaveBeenCalledWith(expect.objectContaining({ mode: "all" }));
  });

  it("trims a reason and passes it through", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["task_a"], reason: "  check the build  " });
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "check the build" }),
    );
  });

  it("drops a whitespace-only reason", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["task_a"], reason: "   " });
    expect(watchTasks).toHaveBeenCalledWith(expect.objectContaining({ reason: undefined }));
  });

  it("drops a non-string reason", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["task_a"], reason: { note: "x" } });
    expect(watchTasks).toHaveBeenCalledWith(expect.objectContaining({ reason: undefined }));
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watch, watchTasks } = build();
    await watch.handler({ task_ids: ["task_a", 7, null, "task_b", undefined] });
    expect(watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_a", "task_b"] }),
    );
  });

  it("errors when task_ids is absent", async () => {
    const { watch, watchTasks } = build();
    const res = await watch.handler({});
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/non-empty array/);
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("errors when task_ids is not an array", async () => {
    const { watch, watchTasks } = build();
    const res = await watch.handler({ task_ids: "task_a" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("errors when every task_ids entry is filtered out", async () => {
    const { watch, watchTasks } = build();
    const res = await watch.handler({ task_ids: [1, 2, 3] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("errors when called outside a session context", async () => {
    const { watch, watchTasks } = build({ sessionId: undefined });
    const res = await watch.handler({ task_ids: ["task_a"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/inside a session context/);
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("validates task_ids before the session-context check", async () => {
    // Both are invalid; the task_ids message is the one the agent sees.
    const { watch } = build({ sessionId: undefined });
    const res = await watch.handler({ task_ids: [] });
    expect(res.content.message).toMatch(/non-empty array/);
  });
});

describe("error taxonomy", () => {
  const cases: Array<[string, Error, string]> = [
    ["an auth error", new WatchAuthError("not your task"), "watch_auth"],
    ["a validation error", new WatchValidationError("bad mode"), "watch_validation"],
    ["a not-found error", new WatchNotFoundError("twch_9"), "watch_not_found"],
    ["any other Error", new Error("pool exhausted"), "watch_error"],
  ];

  for (const [label, err, code] of cases) {
    it(`maps ${label} thrown by watchTasks onto ${code}`, async () => {
      const { watch, watchTasks } = build();
      watchTasks.mockRejectedValue(err);
      const res = await watch.handler({ task_ids: ["task_a"] });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe(code);
      expect(res.content.message).toBe(err.message);
    });

    it(`maps ${label} thrown by unwatch onto ${code}`, async () => {
      const { unwatchTool, unwatch } = build();
      unwatch.mockRejectedValue(err);
      const res = await unwatchTool.handler({ watch_id: "twch_1" });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe(code);
    });
  }

  it("stringifies a non-Error throw under watch_error", async () => {
    const { watch, watchTasks } = build();
    watchTasks.mockRejectedValue("just a string");
    const res = await watch.handler({ task_ids: ["task_a"] });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "watch_error", message: "just a string" });
  });

  it("keeps the WatchNotFoundError id in the message", async () => {
    const { unwatchTool, unwatch } = build();
    unwatch.mockRejectedValue(new WatchNotFoundError("twch_42"));
    const res = await unwatchTool.handler({ watch_id: "twch_42" });
    expect(res.content.message).toBe("task_watch twch_42 not found");
  });
});

describe("unwatch handler", () => {
  it("cancels the watch and returns ok", async () => {
    const { unwatchTool, unwatch } = build();
    const res = await unwatchTool.handler({ watch_id: "twch_3" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(unwatch).toHaveBeenCalledWith({ callerAgentId: AGENT, watchId: "twch_3" });
  });

  it("errors on a missing watch_id", async () => {
    const { unwatchTool, unwatch } = build();
    const res = await unwatchTool.handler({});
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("errors on an empty watch_id", async () => {
    const { unwatchTool, unwatch } = build();
    const res = await unwatchTool.handler({ watch_id: "" });
    expect(res.isError).toBe(true);
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("errors on a non-string watch_id", async () => {
    const { unwatchTool, unwatch } = build();
    const res = await unwatchTool.handler({ watch_id: 99 });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(unwatch).not.toHaveBeenCalled();
  });

  it("does not require a session context", async () => {
    const { unwatchTool, unwatch } = build({ sessionId: undefined });
    const res = await unwatchTool.handler({ watch_id: "twch_3" });
    expect(res.content).toEqual({ ok: true });
    expect(unwatch).toHaveBeenCalled();
  });
});
