/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService — the service owns the
 * auth check, the insert and the already-terminal race. What lives *here*
 * is the part the service never sees: input coercion (task_ids filtering,
 * mode defaulting, reason trimming), the session-context guard, and the
 * error-class → error-code mapping that agents branch on. A fake service
 * lets all of it run without Postgres.
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

function tools(
  ctx: Partial<WatchToolContext>,
  service: Partial<WatchService>,
): Record<string, AgentTool> {
  const built = buildWatchTools(
    { agentId: "agent_1", sessionId: "ses_1", ...ctx },
    { watchService: service as WatchService },
  );
  return Object.fromEntries(built.map((t) => [t.name, t]));
}

const okService = {
  watchTasks: async () => ({ watchId: "tw_1", firedImmediately: false }),
  unwatch: async () => {},
} satisfies Partial<WatchService>;

describe("buildWatchTools", () => {
  it("exposes exactly watch_tasks and unwatch", () => {
    const names = buildWatchTools(
      { agentId: "agent_1", sessionId: "ses_1" },
      { watchService: okService as unknown as WatchService },
    )
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["unwatch", "watch_tasks"]);
  });

  it("declares task_ids and watch_id as the required inputs", () => {
    const t = tools({}, okService);
    expect(t.watch_tasks!.schema.required).toEqual(["task_ids"]);
    expect(t.unwatch!.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks", () => {
  it("passes caller identity, ids, mode and reason through to the service", async () => {
    const watchTasks = vi
      .fn()
      .mockResolvedValue({ watchId: "tw_9", firedImmediately: true });
    const t = tools(
      { agentId: "agent_7", sessionId: "ses_7" },
      { ...okService, watchTasks },
    );

    const res = await t.watch_tasks!.handler({
      task_ids: ["tsk_a", "tsk_b"],
      mode: "any",
      reason: "  waiting on the migration  ",
    });

    expect(watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_7",
      callerSessionId: "ses_7",
      taskIds: ["tsk_a", "tsk_b"],
      mode: "any",
      // Trimmed — the reason is echoed into the wake intent a human reads.
      reason: "waiting on the migration",
    });
    expect(res.isError).toBeUndefined();
    // Snake_case on the wire; the service speaks camelCase.
    expect(res.content).toEqual({ watch_id: "tw_9", fired_immediately: true });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const watchTasks = vi
      .fn()
      .mockResolvedValue({ watchId: "tw_1", firedImmediately: false });
    const t = tools({}, { ...okService, watchTasks });

    await t.watch_tasks!.handler({ task_ids: ["tsk_a"] });
    await t.watch_tasks!.handler({ task_ids: ["tsk_a"], mode: "either" });
    await t.watch_tasks!.handler({ task_ids: ["tsk_a"], mode: 7 });

    for (const call of watchTasks.mock.calls) {
      expect(call[0].mode).toBe("all");
    }
  });

  it("drops non-string task_ids rather than forwarding them", async () => {
    const watchTasks = vi
      .fn()
      .mockResolvedValue({ watchId: "tw_1", firedImmediately: false });
    const t = tools({}, { ...okService, watchTasks });

    await t.watch_tasks!.handler({ task_ids: ["tsk_a", 42, null, "tsk_b"] });

    expect(watchTasks.mock.calls[0]![0].taskIds).toEqual(["tsk_a", "tsk_b"]);
  });

  it("omits an all-whitespace reason instead of sending a blank one", async () => {
    const watchTasks = vi
      .fn()
      .mockResolvedValue({ watchId: "tw_1", firedImmediately: false });
    const t = tools({}, { ...okService, watchTasks });

    await t.watch_tasks!.handler({ task_ids: ["tsk_a"], reason: "   " });

    expect(watchTasks.mock.calls[0]![0].reason).toBeUndefined();
  });

  it.each([
    ["missing", {}],
    ["empty", { task_ids: [] }],
    ["not an array", { task_ids: "tsk_a" }],
    ["all non-strings", { task_ids: [1, 2] }],
  ])("rejects task_ids that are %s without calling the service", async (_label, input) => {
    const watchTasks = vi.fn();
    const t = tools({}, { ...okService, watchTasks });

    const res = await t.watch_tasks!.handler(input);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch outside a session context", async () => {
    // Without a session id the service can't identify the waiter, so the
    // guard has to fire before the call rather than after.
    const watchTasks = vi.fn();
    const t = tools({ sessionId: undefined }, { ...okService, watchTasks });

    const res = await t.watch_tasks!.handler({ task_ids: ["tsk_a"] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(res.content.message).toMatch(/session context/);
    expect(watchTasks).not.toHaveBeenCalled();
  });
});

describe("unwatch", () => {
  it("forwards the watch id with the caller's agent id", async () => {
    const unwatch = vi.fn().mockResolvedValue(undefined);
    const t = tools({ agentId: "agent_3" }, { ...okService, unwatch });

    const res = await t.unwatch!.handler({ watch_id: "tw_5" });

    expect(unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_3",
      watchId: "tw_5",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
  });

  it.each([
    ["missing", {}],
    ["empty", { watch_id: "" }],
    ["not a string", { watch_id: 12 }],
  ])("rejects a watch_id that is %s without calling the service", async (_label, input) => {
    const unwatch = vi.fn();
    const t = tools({}, { ...okService, unwatch });

    const res = await t.unwatch!.handler(input);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(unwatch).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  // The code is the stable identifier agents branch on, so each service
  // error class has to keep landing on its own code — not collapse into
  // the generic one.
  it.each([
    [new WatchAuthError("not yours"), "watch_auth", "not yours"],
    [new WatchValidationError("bad ids"), "watch_validation", "bad ids"],
    [new WatchNotFoundError("tw_404"), "watch_not_found", "task_watch tw_404 not found"],
    [new Error("pool timeout"), "watch_error", "pool timeout"],
  ])("maps %s to its code", async (thrown, code, message) => {
    const t = tools({}, {
      ...okService,
      watchTasks: async () => {
        throw thrown;
      },
    });

    const res = await t.watch_tasks!.handler({ task_ids: ["tsk_a"] });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe(message);
  });

  it("stringifies a non-Error throw rather than leaking undefined", async () => {
    const t = tools({}, {
      ...okService,
      watchTasks: async () => {
        throw "pg died";
      },
    });

    const res = await t.watch_tasks!.handler({ task_ids: ["tsk_a"] });

    expect(res.content).toEqual({ error: "watch_error", message: "pg died" });
  });

  it("applies the same mapping on the unwatch path", async () => {
    const t = tools({}, {
      ...okService,
      unwatch: async () => {
        throw new WatchNotFoundError("tw_gone");
      },
    });

    const res = await t.unwatch!.handler({ watch_id: "tw_gone" });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_not_found");
  });
});
