/**
 * watch_tasks / unwatch unit tests.
 *
 * These two tools back the task-completion wake-up: without a watch, an
 * agent that dispatched work is simply never re-invoked. The adapter
 * layer here is thin, but everything it does is load-bearing —
 * defaulting the mode, refusing a call made outside a session context,
 * and mapping each WatchService error class onto the stable code the
 * calling agent branches on. None of it had a test file.
 *
 * WatchService itself is integration-tested against Postgres
 * (core/src/services/watch-service.test.ts); this file fakes it so the
 * adapter's own branches run without a database.
 */

import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

function fakeService(
  overrides: Partial<{
    watchTasks: WatchService["watchTasks"];
    unwatch: WatchService["unwatch"];
  }> = {},
) {
  const watchTasks = vi.fn(
    overrides.watchTasks ??
      (async () => ({ watchId: "tw_1", firedImmediately: false })),
  );
  const unwatch = vi.fn(overrides.unwatch ?? (async () => undefined));
  return {
    watchService: { watchTasks, unwatch } as unknown as WatchService,
    watchTasks,
    unwatch,
  };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" };

function tools(ctx: WatchToolContext, watchService: WatchService) {
  const built = buildWatchTools(ctx, { watchService });
  const byName = new Map(built.map((t) => [t.name, t]));
  const watchTool = byName.get("watch_tasks");
  const unwatchTool = byName.get("unwatch");
  if (!watchTool || !unwatchTool) throw new Error("missing watch tools");
  return { watchTool, unwatchTool };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { watchService } = fakeService();
    expect(buildWatchTools(CTX, { watchService }).map((t) => t.name)).toEqual([
      "watch_tasks",
      "unwatch",
    ]);
  });

  it("advertises both watch modes on the schema enum", () => {
    const { watchService } = fakeService();
    const { watchTool } = tools(CTX, watchService);
    const props = watchTool.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watchTool.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const f = fakeService();
    const { watchTool } = tools(CTX, f.watchService);

    const result = await watchTool.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(f.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["task_1", "task_2"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "tw_1", fired_immediately: false });
  });

  // "all" is the documented default; an agent that omits `mode` must not
  // silently get "any" and wake on the first of five tasks.
  it("defaults mode to 'all' when omitted or not a valid mode", async () => {
    for (const mode of [undefined, "", "eventually", 1, null]) {
      const f = fakeService();
      const { watchTool } = tools(CTX, f.watchService);
      await watchTool.handler({ task_ids: ["task_1"], mode });
      expect(f.watchTasks.mock.calls[0]?.[0]).toMatchObject({ mode: "all" });
    }
  });

  it("omits a blank or non-string reason instead of passing it through", async () => {
    for (const reason of [undefined, "", "   ", 7]) {
      const f = fakeService();
      const { watchTool } = tools(CTX, f.watchService);
      await watchTool.handler({ task_ids: ["task_1"], reason });
      expect(f.watchTasks.mock.calls[0]?.[0]?.reason).toBeUndefined();
    }
  });

  it("filters non-string entries out of task_ids", async () => {
    const f = fakeService();
    const { watchTool } = tools(CTX, f.watchService);
    await watchTool.handler({ task_ids: ["task_1", 42, null, "task_2"] });
    expect(f.watchTasks.mock.calls[0]?.[0]?.taskIds).toEqual(["task_1", "task_2"]);
  });

  it("rejects an empty, absent or all-junk task_ids without calling the service", async () => {
    for (const task_ids of [undefined, [], "task_1", [42, null]]) {
      const f = fakeService();
      const { watchTool } = tools(CTX, f.watchService);
      const result = await watchTool.handler({ task_ids });
      expect(result.isError, JSON.stringify(task_ids)).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(f.watchTasks).not.toHaveBeenCalled();
    }
  });

  // Without a session id the service cannot identify the waiter, so the
  // watch would be unroutable — refuse rather than insert a dead row.
  it("refuses when the tool call has no session context", async () => {
    const f = fakeService();
    const { watchTool } = tools({ agentId: "agent_a" }, f.watchService);
    const result = await watchTool.handler({ task_ids: ["task_1"] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(f.watchTasks).not.toHaveBeenCalled();
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const f = fakeService({
      watchTasks: (async () => ({
        watchId: "tw_hot",
        firedImmediately: true,
      })) as unknown as WatchService["watchTasks"],
    });
    const { watchTool } = tools(CTX, f.watchService);
    const result = await watchTool.handler({ task_ids: ["task_done"] });
    expect(result.content).toEqual({ watch_id: "tw_hot", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("delegates to the service with the caller's agent id", async () => {
    const f = fakeService();
    const { unwatchTool } = tools(CTX, f.watchService);
    const result = await unwatchTool.handler({ watch_id: "tw_1" });
    expect(f.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    for (const watch_id of [undefined, "", 42, null]) {
      const f = fakeService();
      const { unwatchTool } = tools(CTX, f.watchService);
      const result = await unwatchTool.handler({ watch_id });
      expect(result.isError, String(watch_id)).toBe(true);
      expect(result.content).toMatchObject({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
      expect(f.unwatch).not.toHaveBeenCalled();
    }
  });

  // The description promises idempotence; unwatch is allowed to work
  // without a session context (unlike watch_tasks).
  it("works without a session context", async () => {
    const f = fakeService();
    const { unwatchTool } = tools({ agentId: "agent_a" }, f.watchService);
    expect((await unwatchTool.handler({ watch_id: "tw_1" })).content).toEqual({
      ok: true,
    });
  });
});

/**
 * The error mapping is the part agents actually branch on: an auth
 * failure ("that task isn't in your chain") means stop, a validation
 * failure means fix the arguments, and a not-found on unwatch is benign.
 * Collapsing them all to one code would make that undecidable.
 */
describe("error mapping — shared by both tools", () => {
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not your chain"), "watch_auth"],
    ["WatchValidationError", new WatchValidationError("bad mode"), "watch_validation"],
    ["WatchNotFoundError", new WatchNotFoundError("no such watch"), "watch_not_found"],
    ["a plain Error", new Error("pg down"), "watch_error"],
    ["a non-Error throw", "kaboom", "watch_error"],
  ];

  for (const [label, thrown, code] of cases) {
    it(`maps ${label} to ${code} on watch_tasks`, async () => {
      const f = fakeService({
        watchTasks: (async () => {
          throw thrown;
        }) as unknown as WatchService["watchTasks"],
      });
      const { watchTool } = tools(CTX, f.watchService);
      const result = await watchTool.handler({ task_ids: ["task_1"] });
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(code);
      expect(typeof result.content.message).toBe("string");
    });

    it(`maps ${label} to ${code} on unwatch`, async () => {
      const f = fakeService({
        unwatch: (async () => {
          throw thrown;
        }) as unknown as WatchService["unwatch"],
      });
      const { unwatchTool } = tools(CTX, f.watchService);
      const result = await unwatchTool.handler({ watch_id: "tw_1" });
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(code);
    });
  }

  it("preserves the thrown message for the human reading the transcript", async () => {
    const f = fakeService({
      watchTasks: (async () => {
        throw new WatchAuthError("task(s) not dispatched in your conversation chain: t1");
      }) as unknown as WatchService["watchTasks"],
    });
    const { watchTool } = tools(CTX, f.watchService);
    const result = await watchTool.handler({ task_ids: ["t1"] });
    expect(result.content.message).toBe(
      "task(s) not dispatched in your conversation chain: t1",
    );
  });
});
