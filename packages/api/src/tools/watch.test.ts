/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService, so the seam under test
 * is the adapter itself: input coercion (what shapes survive, what gets
 * rejected before the service is reached), the ctx.sessionId requirement,
 * and the error-class → error-code mapping. A fake WatchService keeps
 * this off Postgres — the service's own behavior is covered by
 * core's watch-service tests.
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

interface Fake {
  watchService: WatchService;
  watchTasks: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
}

function fakeWatchService(overrides: Partial<Fake> = {}): Fake {
  const watchTasks =
    overrides.watchTasks ??
    vi.fn(async () => ({ watchId: "twh_1", firedImmediately: false }));
  const unwatch = overrides.unwatch ?? vi.fn(async () => undefined);
  return {
    watchTasks,
    unwatch,
    watchService: { watchTasks, unwatch } as unknown as WatchService,
  };
}

const ctx: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" };

function tools(
  c: WatchToolContext = ctx,
  fake: Fake = fakeWatchService(),
): { watch: AgentTool; unwatch: AgentTool; fake: Fake } {
  const built = buildWatchTools(c, { watchService: fake.watchService });
  const watch = built.find((t) => t.name === "watch_tasks")!;
  const unwatch = built.find((t) => t.name === "unwatch")!;
  return { watch, unwatch, fake };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks then unwatch", () => {
    const built = buildWatchTools(ctx, {
      watchService: fakeWatchService().watchService,
    });
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the mode enum on watch_tasks so agents see the valid values", () => {
    const { watch } = tools();
    const props = watch.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watch.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks handler", () => {
  it("passes caller identity, ids, mode and reason through to the service", async () => {
    const { watch, fake } = tools();

    const result = await watch.handler({
      task_ids: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(fake.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "need the first result",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "twh_1",
      fired_immediately: false,
    });
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const fake = fakeWatchService({
      watchTasks: vi.fn(async () => ({
        watchId: "twh_now",
        firedImmediately: true,
      })),
    });
    const { watch } = tools(ctx, fake);

    const result = await watch.handler({ task_ids: ["tsk_1"] });

    expect(result.content).toEqual({
      watch_id: "twh_now",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const { watch, fake } = tools();

    await watch.handler({ task_ids: ["tsk_1"] });
    await watch.handler({ task_ids: ["tsk_1"], mode: "eventually" });
    await watch.handler({ task_ids: ["tsk_1"], mode: 7 });

    for (const call of fake.watchTasks.mock.calls) {
      expect(call[0]).toMatchObject({ mode: "all" });
    }
  });

  it("drops non-string entries from task_ids rather than passing them on", async () => {
    const { watch, fake } = tools();

    await watch.handler({ task_ids: ["tsk_1", 42, null, "tsk_2"] });

    expect(fake.watchTasks.mock.calls[0]?.[0]).toMatchObject({
      taskIds: ["tsk_1", "tsk_2"],
    });
  });

  it("omits reason when it is blank, whitespace, or the wrong type", async () => {
    const { watch, fake } = tools();

    await watch.handler({ task_ids: ["tsk_1"], reason: "   " });
    await watch.handler({ task_ids: ["tsk_1"], reason: 12 });
    await watch.handler({ task_ids: ["tsk_1"] });

    for (const call of fake.watchTasks.mock.calls) {
      expect(call[0].reason).toBeUndefined();
    }
  });

  it("rejects an empty, absent, or all-non-string task_ids before calling the service", async () => {
    const { watch, fake } = tools();

    for (const input of [{}, { task_ids: [] }, { task_ids: [1, 2] }, { task_ids: "tsk_1" }]) {
      const result = await watch.handler(input as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content.error).toBe("watch_validation");
    }
    expect(fake.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch without a session context", async () => {
    const fake = fakeWatchService();
    const { watch } = tools({ agentId: "agent_a" }, fake);

    const result = await watch.handler({ task_ids: ["tsk_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(result.content.message).toContain("session context");
    expect(fake.watchTasks).not.toHaveBeenCalled();
  });
});

describe("unwatch handler", () => {
  it("cancels by id for the calling agent", async () => {
    const { unwatch, fake } = tools();

    const result = await unwatch.handler({ watch_id: "twh_1" });

    expect(fake.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "twh_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id before calling the service", async () => {
    const { unwatch, fake } = tools();

    for (const input of [{}, { watch_id: "" }, { watch_id: 5 }]) {
      const result = await unwatch.handler(input as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(fake.unwatch).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  // The codes are the agent-facing contract — an agent branches on
  // `error` to decide whether to retry, so each service error class has
  // to keep landing on its own code rather than the generic one.
  const cases: Array<[string, unknown, string]> = [
    ["auth", new WatchAuthError("not your task"), "watch_auth"],
    ["validation", new WatchValidationError("bad ids"), "watch_validation"],
    ["not found", new WatchNotFoundError("twh_missing"), "watch_not_found"],
    ["generic Error", new Error("pool exhausted"), "watch_error"],
    ["non-Error throw", "kaboom", "watch_error"],
  ];

  for (const [label, thrown, code] of cases) {
    it(`maps a ${label} out of watch_tasks to ${code}`, async () => {
      const fake = fakeWatchService({
        watchTasks: vi.fn(async () => {
          throw thrown;
        }),
      });
      const { watch } = tools(ctx, fake);

      const result = await watch.handler({ task_ids: ["tsk_1"] });

      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(code);
      expect(typeof result.content.message).toBe("string");
    });

    it(`maps a ${label} out of unwatch to ${code}`, async () => {
      const fake = fakeWatchService({
        unwatch: vi.fn(async () => {
          throw thrown;
        }),
      });
      const { unwatch } = tools(ctx, fake);

      const result = await unwatch.handler({ watch_id: "twh_1" });

      expect(result.isError).toBe(true);
      expect(result.content.error).toBe(code);
    });
  }

  it("stringifies a non-Error throw into the message", async () => {
    const fake = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw { nope: true };
      }),
    });
    const { watch } = tools(ctx, fake);

    const result = await watch.handler({ task_ids: ["tsk_1"] });

    expect(result.content.message).toBe("[object Object]");
  });
});
