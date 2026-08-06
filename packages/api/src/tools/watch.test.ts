import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Harness {
  services: { watchService: WatchService };
  watchCalls: Array<Record<string, unknown>>;
  unwatchCalls: Array<Record<string, unknown>>;
}

function harness(
  overrides: {
    watchImpl?: () => Promise<unknown>;
    unwatchImpl?: () => Promise<unknown>;
  } = {},
): Harness {
  const watchCalls: Array<Record<string, unknown>> = [];
  const unwatchCalls: Array<Record<string, unknown>> = [];

  const watchService = {
    watchTasks: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.watchImpl) return overrides.watchImpl();
      watchCalls.push(input);
      return { watchId: "twatch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.unwatchImpl) return overrides.unwatchImpl();
      unwatchCalls.push(input);
    }),
  } as unknown as WatchService;

  return { services: { watchService }, watchCalls, unwatchCalls };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function tools(h: Harness, ctx: WatchToolContext = CTX) {
  const [watchTasks, unwatch] = buildWatchTools(ctx, h.services);
  return { watchTasks: watchTasks!, unwatch: unwatch! };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const built = buildWatchTools(CTX, harness().services);

    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both fire modes on the watch_tasks schema", () => {
    const { watchTasks, unwatch } = tools(harness());
    const props = watchTasks.schema.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    expect(unwatch.schema.required).toEqual(["watch_id"]);
  });
});

describe("watch_tasks tool", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const h = harness();
    const result = await tools(h).watchTasks.handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "  need the first result  ",
    });

    expect(h.watchCalls).toEqual([
      {
        callerAgentId: "agent_a",
        callerSessionId: "sess_1",
        taskIds: ["task_1", "task_2"],
        mode: "any",
        reason: "need the first result",
      },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "twatch_1",
      fired_immediately: false,
    });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    for (const mode of [undefined, "sometimes", 3, null]) {
      const h = harness();
      await tools(h).watchTasks.handler({ task_ids: ["task_1"], mode });
      expect(h.watchCalls[0]?.mode).toBe("all");
    }
  });

  it("omits reason when it is blank or not a string", async () => {
    for (const reason of [undefined, "   ", 7]) {
      const h = harness();
      await tools(h).watchTasks.handler({ task_ids: ["task_1"], reason });
      expect(h.watchCalls[0]?.reason).toBeUndefined();
    }
  });

  it("drops non-string entries from task_ids", async () => {
    const h = harness();
    await tools(h).watchTasks.handler({
      task_ids: ["task_1", 42, null, "task_2", { id: "task_3" }],
    });

    expect(h.watchCalls[0]?.taskIds).toEqual(["task_1", "task_2"]);
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const h = harness({
      watchImpl: async () => ({ watchId: "twatch_9", firedImmediately: true }),
    });
    const result = await tools(h).watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "twatch_9",
      fired_immediately: true,
    });
  });

  describe("validation", () => {
    it.each([
      ["an empty array", []],
      ["a non-array", "task_1"],
      ["an array with no strings in it", [1, null, {}]],
      ["an omitted field", undefined],
    ])("refuses %s of task_ids before calling the service", async (_l, task_ids) => {
      const h = harness();
      const result = await tools(h).watchTasks.handler({ task_ids });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(h.services.watchService.watchTasks).not.toHaveBeenCalled();
    });

    it("refuses to register a watch with no session to wake", async () => {
      const h = harness();
      const result = await tools(h, { agentId: "agent_a" }).watchTasks.handler({
        task_ids: ["task_1"],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "watch_validation",
        message: "watch_tasks must be called inside a session context",
      });
      expect(h.services.watchService.watchTasks).not.toHaveBeenCalled();
    });
  });
});

describe("unwatch tool", () => {
  it("forwards the caller agent id and watch id", async () => {
    const h = harness();
    const result = await tools(h).unwatch.handler({ watch_id: "twatch_1" });

    expect(h.unwatchCalls).toEqual([
      { callerAgentId: "agent_a", watchId: "twatch_1" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 42],
    ["an omitted field", undefined],
  ])("refuses %s of watch_id before calling the service", async (_l, watch_id) => {
    const h = harness();
    const result = await tools(h).unwatch.handler({ watch_id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(h.services.watchService.unwatch).not.toHaveBeenCalled();
  });
});

describe("service error translation", () => {
  const cases: Array<[string, () => unknown, string, string]> = [
    [
      "WatchAuthError",
      () => new WatchAuthError("task task_1 is not in your chain"),
      "watch_auth",
      "task task_1 is not in your chain",
    ],
    [
      "WatchValidationError",
      () => new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
      "task_ids must be non-empty",
    ],
    [
      "WatchNotFoundError",
      () => new WatchNotFoundError("twatch_missing"),
      "watch_not_found",
      "task_watch twatch_missing not found",
    ],
    [
      "a plain Error",
      () => new Error("pool exhausted"),
      "watch_error",
      "pool exhausted",
    ],
    ["a thrown non-Error", () => "kaboom", "watch_error", "kaboom"],
  ];

  it.each(cases)(
    "maps %s thrown by watchTasks to a coded tool error",
    async (_label, make, code, message) => {
      const h = harness({
        watchImpl: async () => {
          throw make();
        },
      });
      const result = await tools(h).watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message });
    },
  );

  it.each(cases)(
    "maps %s thrown by unwatch to a coded tool error",
    async (_label, make, code, message) => {
      const h = harness({
        unwatchImpl: async () => {
          throw make();
        },
      });
      const result = await tools(h).unwatch.handler({ watch_id: "twatch_1" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: code, message });
    },
  );
});
