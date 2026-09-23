import { describe, expect, it, vi } from "vitest";
import { TASK_WATCH_MODES } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool } from "./types.js";

/**
 * watch_tasks + unwatch are thin adapters over WatchService — the
 * service owns the auth check, the insert, and the already-terminal
 * race. What lives *here*, and so what's worth testing here, is:
 *
 *   - input coercion (mode defaulting, task_ids filtering, reason
 *     trimming) — the MCP wire is untyped, so a tool call can carry
 *     anything;
 *   - the session-context guard, which fails closed because a watch
 *     with no waiter can never fire;
 *   - the error taxonomy, which maps each WatchService error class onto
 *     a distinct code the calling agent branches on. A missed branch
 *     collapses a 'you don't own this task' into a generic failure.
 */

const AGENT_ID = "agent_caller";
const SESSION_ID = "sess_caller";

function fakeWatchService(
  opts: {
    watchThrows?: unknown;
    unwatchThrows?: unknown;
    firedImmediately?: boolean;
    watchId?: string;
  } = {},
): WatchService & { watchTasks: ReturnType<typeof vi.fn>; unwatch: ReturnType<typeof vi.fn> } {
  const watchTasks = vi.fn(async () => {
    if (opts.watchThrows) throw opts.watchThrows;
    return {
      watchId: opts.watchId ?? "tw_1",
      firedImmediately: opts.firedImmediately ?? false,
    };
  });
  const unwatch = vi.fn(async () => {
    if (opts.unwatchThrows) throw opts.unwatchThrows;
  });
  return { watchTasks, unwatch } as unknown as WatchService & {
    watchTasks: ReturnType<typeof vi.fn>;
    unwatch: ReturnType<typeof vi.fn>;
  };
}

function tools(
  service: WatchService,
  ctx: Partial<WatchToolContext> = {},
): { watchTasks: AgentTool; unwatch: AgentTool } {
  const built = buildWatchTools(
    { agentId: AGENT_ID, sessionId: SESSION_ID, ...ctx },
    { watchService: service },
  );
  const byName = new Map(built.map((t) => [t.name, t]));
  return {
    watchTasks: byName.get("watch_tasks")!,
    unwatch: byName.get("unwatch")!,
  };
}

describe("buildWatchTools — surface", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const built = buildWatchTools(
      { agentId: AGENT_ID, sessionId: SESSION_ID },
      { watchService: fakeWatchService() },
    );
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises exactly the domain's watch modes in the schema enum", () => {
    // The enum is generated from TASK_WATCH_MODES — adding a mode to the
    // domain without it reaching the agent-facing schema is the bug.
    const { watchTasks } = tools(fakeWatchService());
    const props = (watchTasks.schema as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(props.mode!.enum).toEqual([...TASK_WATCH_MODES]);
    expect((watchTasks.schema as { required: string[] }).required).toEqual(["task_ids"]);
  });

  it("requires watch_id on unwatch", () => {
    const { unwatch } = tools(fakeWatchService());
    expect((unwatch.schema as { required: string[] }).required).toEqual(["watch_id"]);
  });

  it("documents the one-shot contract and both fire modes", () => {
    const { watchTasks } = tools(fakeWatchService());
    expect(watchTasks.description).toMatch(/one-shot/);
    expect(watchTasks.description).toMatch(/EVERY task/);
    expect(watchTasks.description).toMatch(/FIRST task/);
  });
});

describe("watch_tasks — input coercion", () => {
  it("forwards the task ids, mode and trimmed reason", async () => {
    const svc = fakeWatchService();
    await tools(svc).watchTasks.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the first result  ",
    });
    expect(svc.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });
  });

  it("defaults mode to 'all' when absent or not a valid mode", async () => {
    for (const mode of [undefined, "sometimes", "", 5, null]) {
      const svc = fakeWatchService();
      await tools(svc).watchTasks.handler({ task_ids: ["task_a"], mode });
      expect(svc.watchTasks.mock.calls[0]![0]).toMatchObject({ mode: "all" });
    }
  });

  it("accepts every declared mode verbatim", async () => {
    for (const mode of TASK_WATCH_MODES) {
      const svc = fakeWatchService();
      await tools(svc).watchTasks.handler({ task_ids: ["task_a"], mode });
      expect(svc.watchTasks.mock.calls[0]![0]).toMatchObject({ mode });
    }
  });

  it("drops non-string entries from task_ids", async () => {
    const svc = fakeWatchService();
    await tools(svc).watchTasks.handler({
      task_ids: ["task_a", 42, null, { id: "x" }, "task_b"],
    });
    expect(svc.watchTasks.mock.calls[0]![0]).toMatchObject({
      taskIds: ["task_a", "task_b"],
    });
  });

  it("omits a blank or non-string reason instead of forwarding an empty string", async () => {
    for (const reason of [undefined, "", "   ", 7]) {
      const svc = fakeWatchService();
      await tools(svc).watchTasks.handler({ task_ids: ["task_a"], reason });
      expect(svc.watchTasks.mock.calls[0]![0].reason).toBeUndefined();
    }
  });
});

describe("watch_tasks — validation", () => {
  it("rejects task_ids that isn't an array", async () => {
    for (const task_ids of [undefined, "task_a", 5, null, {}]) {
      const svc = fakeWatchService();
      const result = await tools(svc).watchTasks.handler({ task_ids });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(svc.watchTasks).not.toHaveBeenCalled();
    }
  });

  it("rejects an empty array, and one holding no strings", async () => {
    for (const task_ids of [[], [1, 2], [null]]) {
      const svc = fakeWatchService();
      const result = await tools(svc).watchTasks.handler({ task_ids });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(String((result.content as { message: string }).message)).toMatch(/non-empty/);
      expect(svc.watchTasks).not.toHaveBeenCalled();
    }
  });

  it("fails closed with no session context — a watch with no waiter can't fire", async () => {
    const svc = fakeWatchService();
    const result = await tools(svc, { sessionId: undefined }).watchTasks.handler({
      task_ids: ["task_a"],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(String((result.content as { message: string }).message)).toMatch(/session context/);
    expect(svc.watchTasks).not.toHaveBeenCalled();
  });
});

describe("watch_tasks — result", () => {
  it("returns the watch id and fired_immediately: false for a pending watch", async () => {
    const svc = fakeWatchService({ watchId: "tw_pending", firedImmediately: false });
    const result = await tools(svc).watchTasks.handler({ task_ids: ["task_a"] });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "tw_pending", fired_immediately: false });
  });

  it("surfaces fired_immediately when the tasks were already terminal", async () => {
    const svc = fakeWatchService({ watchId: "tw_raced", firedImmediately: true });
    const result = await tools(svc).watchTasks.handler({ task_ids: ["task_a"] });
    expect(result.content).toEqual({ watch_id: "tw_raced", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("forwards the watch id with the caller's agent id", async () => {
    const svc = fakeWatchService();
    const result = await tools(svc).unwatch.handler({ watch_id: "tw_1" });
    expect(result.content).toEqual({ ok: true });
    expect(svc.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "tw_1",
    });
  });

  it("rejects a missing or non-string watch_id", async () => {
    for (const watch_id of [undefined, "", 5, null]) {
      const svc = fakeWatchService();
      const result = await tools(svc).unwatch.handler({ watch_id });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(svc.unwatch).not.toHaveBeenCalled();
    }
  });

  it("is idempotent — ok even for a watch the service reports as already gone", async () => {
    // The tool documents itself as idempotent; the service resolving
    // quietly for a fired/aborted watch must stay an ok, not an error.
    const svc = fakeWatchService();
    expect(await tools(svc).unwatch.handler({ watch_id: "tw_fired" })).toEqual({
      content: { ok: true },
    });
  });
});

describe("watch tools — error taxonomy", () => {
  // Each WatchService error class gets its own code because the calling
  // agent's recovery differs: auth means stop, validation means fix the
  // args, not_found means the watch is already gone.
  const cases: Array<[unknown, string]> = [
    [new WatchAuthError("task not in your chain"), "watch_auth"],
    [new WatchValidationError("too many tasks"), "watch_validation"],
    [new WatchNotFoundError("tw_missing"), "watch_not_found"],
    [new Error("pool exhausted"), "watch_error"],
    ["a bare string", "watch_error"],
  ];

  for (const [thrown, code] of cases) {
    it(`maps ${thrown instanceof Error ? thrown.name : "a non-Error"} to ${code} on watch_tasks`, async () => {
      const svc = fakeWatchService({ watchThrows: thrown });
      const result = await tools(svc).watchTasks.handler({ task_ids: ["task_a"] });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code });
    });

    it(`maps ${thrown instanceof Error ? thrown.name : "a non-Error"} to ${code} on unwatch`, async () => {
      const svc = fakeWatchService({ unwatchThrows: thrown });
      const result = await tools(svc).unwatch.handler({ watch_id: "tw_1" });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code });
    });
  }

  it("carries the thrown message through, and stringifies a non-Error", async () => {
    const withMessage = fakeWatchService({
      watchThrows: new WatchAuthError("task_x is not yours"),
    });
    expect(
      await tools(withMessage).watchTasks.handler({ task_ids: ["task_x"] }),
    ).toMatchObject({ content: { message: "task_x is not yours" } });

    const nonError = fakeWatchService({ watchThrows: 404 });
    expect(
      await tools(nonError).watchTasks.handler({ task_ids: ["task_x"] }),
    ).toMatchObject({ content: { error: "watch_error", message: "404" } });
  });

  it("names the missing watch in the not-found message", async () => {
    const svc = fakeWatchService({ unwatchThrows: new WatchNotFoundError("tw_missing") });
    const result = await tools(svc).unwatch.handler({ watch_id: "tw_missing" });
    expect(String((result.content as { message: string }).message)).toContain("tw_missing");
  });
});
