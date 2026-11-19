import { describe, expect, it, vi } from "vitest";
import { TASK_WATCH_MODES } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
  type UnwatchInput,
} from "@beevibe/core/services/watch-service";
import {
  buildWatchTools,
  type WatchToolContext,
  type WatchToolServices,
} from "./watch.js";

interface Harness {
  services: WatchToolServices;
  watchCalls: WatchTasksInput[];
  unwatchCalls: UnwatchInput[];
}

function harness(
  opts: {
    watchResult?: { watchId: string; firedImmediately: boolean };
    watchThrows?: unknown;
    unwatchThrows?: unknown;
  } = {},
): Harness {
  const watchCalls: WatchTasksInput[] = [];
  const unwatchCalls: UnwatchInput[] = [];

  const watchService = {
    watchTasks: vi.fn(async (input: WatchTasksInput) => {
      watchCalls.push(input);
      if (opts.watchThrows !== undefined) throw opts.watchThrows;
      return opts.watchResult ?? { watchId: "watch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: UnwatchInput) => {
      unwatchCalls.push(input);
      if (opts.unwatchThrows !== undefined) throw opts.unwatchThrows;
    }),
  } as unknown as WatchService;

  return { services: { watchService }, watchCalls, unwatchCalls };
}

const CTX: WatchToolContext = { agentId: "agent_lead", sessionId: "sess_now" };

function tools(h: Harness, ctx: WatchToolContext = CTX) {
  return buildWatchTools(ctx, h.services);
}

function watchTasks(h: Harness, ctx: WatchToolContext = CTX) {
  const t = tools(h, ctx).find((x) => x.name === "watch_tasks");
  if (!t) throw new Error("watch_tasks tool missing");
  return t;
}

function unwatch(h: Harness, ctx: WatchToolContext = CTX) {
  const t = tools(h, ctx).find((x) => x.name === "unwatch");
  if (!t) throw new Error("unwatch tool missing");
  return t;
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const built = tools(harness());
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the real mode enum, not a hand-copied list", () => {
    const schema = watchTasks(harness()).schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.mode.enum).toEqual([...TASK_WATCH_MODES]);
    expect(schema.required).toEqual(["task_ids"]);
  });

  it("documents the fire contract in the agent-facing description", () => {
    const t = watchTasks(harness());
    expect(t.description).toContain("one-shot");
    expect(t.description).toContain("fired_immediately");
    expect(unwatch(harness()).description).toContain("Idempotent");
  });
});

describe("watch_tasks handler", () => {
  it("registers the watch and returns the service's ids", async () => {
    const h = harness({ watchResult: { watchId: "watch_abc", firedImmediately: true } });
    const result = await watchTasks(h).handler({
      task_ids: ["task_1", "task_2"],
      mode: "any",
      reason: "need the first result",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "watch_abc",
      fired_immediately: true,
    });
    expect(h.watchCalls).toEqual([
      {
        callerAgentId: "agent_lead",
        callerSessionId: "sess_now",
        taskIds: ["task_1", "task_2"],
        mode: "any",
        reason: "need the first result",
      },
    ]);
  });

  describe("task_ids", () => {
    it.each([
      ["omitted", undefined],
      ["an empty array", []],
      ["a bare string", "task_1"],
      ["null", null],
      ["an array of only non-strings", [1, null, { id: "task_1" }]],
    ])("rejects task_ids given as %s", async (_label, value) => {
      const h = harness();
      const result = await watchTasks(h).handler(
        value === undefined ? {} : { task_ids: value },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "watch_validation",
        message: "task_ids must be a non-empty array of strings",
      });
      expect(h.watchCalls).toEqual([]);
    });

    it("keeps the string entries and drops the rest", async () => {
      const h = harness();
      const result = await watchTasks(h).handler({
        task_ids: ["task_1", 2, null, "task_3", undefined],
      });

      expect(result.isError).toBeFalsy();
      expect(h.watchCalls[0]?.taskIds).toEqual(["task_1", "task_3"]);
    });
  });

  describe("mode", () => {
    it("defaults to all when omitted", async () => {
      const h = harness();
      await watchTasks(h).handler({ task_ids: ["task_1"] });
      expect(h.watchCalls[0]?.mode).toBe("all");
    });

    it.each([
      ["an unknown string", "first"],
      ["a number", 1],
      ["null", null],
      ["wrong case", "ALL"],
    ])("falls back to all for %s", async (_label, value) => {
      const h = harness();
      await watchTasks(h).handler({ task_ids: ["task_1"], mode: value });
      expect(h.watchCalls[0]?.mode).toBe("all");
    });

    it.each([...TASK_WATCH_MODES])("passes %s through", async (mode) => {
      const h = harness();
      await watchTasks(h).handler({ task_ids: ["task_1"], mode });
      expect(h.watchCalls[0]?.mode).toBe(mode);
    });
  });

  describe("reason", () => {
    it("trims it", async () => {
      const h = harness();
      await watchTasks(h).handler({
        task_ids: ["task_1"],
        reason: "   waiting on the migration   ",
      });
      expect(h.watchCalls[0]?.reason).toBe("waiting on the migration");
    });

    it.each([
      ["omitted", undefined],
      ["empty", ""],
      ["whitespace only", "   \n "],
      ["a number", 3],
    ])("omits a %s reason", async (_label, value) => {
      const h = harness();
      await watchTasks(h).handler({
        task_ids: ["task_1"],
        ...(value === undefined ? {} : { reason: value }),
      });
      expect(h.watchCalls[0]?.reason).toBeUndefined();
    });
  });

  describe("session context", () => {
    it("refuses when the caller has no session id", async () => {
      const h = harness();
      const result = await watchTasks(h, { agentId: "agent_lead" }).handler({
        task_ids: ["task_1"],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "watch_validation",
        message: "watch_tasks must be called inside a session context",
      });
      expect(h.watchCalls).toEqual([]);
    });

    it("checks task_ids before the session context", async () => {
      const h = harness();
      const result = await watchTasks(h, { agentId: "agent_lead" }).handler({
        task_ids: [],
      });

      expect(result.content).toMatchObject({
        message: "task_ids must be a non-empty array of strings",
      });
    });
  });

  describe("error mapping", () => {
    it("maps WatchAuthError to watch_auth", async () => {
      const h = harness({ watchThrows: new WatchAuthError("task_9 is not yours") });
      const result = await watchTasks(h).handler({ task_ids: ["task_9"] });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "watch_auth",
        message: "task_9 is not yours",
      });
    });

    it("maps WatchValidationError to watch_validation", async () => {
      const h = harness({ watchThrows: new WatchValidationError("too many tasks") });
      const result = await watchTasks(h).handler({ task_ids: ["task_1"] });

      expect(result.content).toEqual({
        error: "watch_validation",
        message: "too many tasks",
      });
    });

    it("maps WatchNotFoundError to watch_not_found", async () => {
      const h = harness({ watchThrows: new WatchNotFoundError("watch_404") });
      const result = await watchTasks(h).handler({ task_ids: ["task_1"] });

      expect(result.content).toEqual({
        error: "watch_not_found",
        message: "task_watch watch_404 not found",
      });
    });

    it("maps any other Error to watch_error", async () => {
      const h = harness({ watchThrows: new TypeError("pool exhausted") });
      const result = await watchTasks(h).handler({ task_ids: ["task_1"] });

      expect(result.content).toEqual({
        error: "watch_error",
        message: "pool exhausted",
      });
    });

    it("stringifies a non-Error throw", async () => {
      const h = harness({ watchThrows: "db gone" });
      const result = await watchTasks(h).handler({ task_ids: ["task_1"] });

      expect(result.content).toEqual({ error: "watch_error", message: "db gone" });
    });
  });
});

describe("unwatch handler", () => {
  it("cancels the watch and reports ok", async () => {
    const h = harness();
    const result = await unwatch(h).handler({ watch_id: "watch_abc" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
    expect(h.unwatchCalls).toEqual([
      { callerAgentId: "agent_lead", watchId: "watch_abc" },
    ]);
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["a number", 5],
    ["null", null],
  ])("rejects a %s watch_id", async (_label, value) => {
    const h = harness();
    const result = await unwatch(h).handler(
      value === undefined ? {} : { watch_id: value },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(h.unwatchCalls).toEqual([]);
  });

  it("does not trim the watch_id — a padded id is passed through as given", async () => {
    const h = harness();
    await unwatch(h).handler({ watch_id: " watch_abc " });
    expect(h.unwatchCalls[0]?.watchId).toBe(" watch_abc ");
  });

  it.each([
    [new WatchAuthError("not your watch"), "watch_auth"],
    [new WatchValidationError("already aborted"), "watch_validation"],
    [new WatchNotFoundError("watch_404"), "watch_not_found"],
    [new Error("boom"), "watch_error"],
  ])("maps %s through the shared mapper", async (thrown, code) => {
    const h = harness({ unwatchThrows: thrown });
    const result = await unwatch(h).handler({ watch_id: "watch_abc" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });

  it("stringifies a non-Error throw", async () => {
    const h = harness({ unwatchThrows: { code: "X" } });
    const result = await unwatch(h).handler({ watch_id: "watch_abc" });

    expect(result.content).toMatchObject({ error: "watch_error" });
    expect(typeof (result.content as { message: unknown }).message).toBe("string");
  });
});
