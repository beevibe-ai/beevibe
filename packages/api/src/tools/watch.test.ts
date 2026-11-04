import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
  type WatchTasksResult,
  type UnwatchInput,
} from "@beevibe/core/services/watch-service";
import {
  buildWatchTools,
  type WatchToolContext,
  type WatchToolServices,
} from "./watch.js";

/**
 * Both tools are thin adapters over WatchService: the input coercion,
 * the two pre-service validations, and the error-class -> error-code
 * mapping are the only logic they own. A recording fake is enough to
 * pin all three.
 */
function fakeServices(overrides?: {
  watchTasks?: (input: WatchTasksInput) => Promise<WatchTasksResult>;
  unwatch?: (input: UnwatchInput) => Promise<void>;
}): {
  services: WatchToolServices;
  watchCalls: WatchTasksInput[];
  unwatchCalls: UnwatchInput[];
} {
  const watchCalls: WatchTasksInput[] = [];
  const unwatchCalls: UnwatchInput[] = [];
  const watchService = {
    watchTasks: vi.fn(async (input: WatchTasksInput) => {
      watchCalls.push(input);
      if (overrides?.watchTasks) return overrides.watchTasks(input);
      return { watchId: "watch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: UnwatchInput) => {
      unwatchCalls.push(input);
      if (overrides?.unwatch) return overrides.unwatch(input);
    }),
  } as unknown as WatchService;
  return { services: { watchService }, watchCalls, unwatchCalls };
}

const ctx: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function tools(
  services: WatchToolServices,
  context: WatchToolContext = ctx,
): { watchTasks: ReturnType<typeof buildWatchTools>[number]; unwatch: ReturnType<typeof buildWatchTools>[number] } {
  const built = buildWatchTools(context, services);
  const watchTasks = built.find((t) => t.name === "watch_tasks");
  const unwatch = built.find((t) => t.name === "unwatch");
  if (!watchTasks || !unwatch) throw new Error("expected both watch tools");
  return { watchTasks, unwatch };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const { services } = fakeServices();
    const built = buildWatchTools(ctx, services);
    expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares task_ids required on watch_tasks and watch_id on unwatch", () => {
    const { services } = fakeServices();
    const { watchTasks, unwatch } = tools(services);
    expect(watchTasks.schema).toMatchObject({
      type: "object",
      required: ["task_ids"],
    });
    expect(unwatch.schema).toMatchObject({
      type: "object",
      required: ["watch_id"],
    });
  });

  it("offers every supported mode in the watch_tasks schema", () => {
    const { services } = fakeServices();
    const { watchTasks } = tools(services);
    const properties = (watchTasks.schema as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(properties.mode?.enum).toEqual(expect.arrayContaining(["all", "any"]));
  });

  it("documents the contract in both descriptions", () => {
    const { services } = fakeServices();
    const { watchTasks, unwatch } = tools(services);
    expect(watchTasks.description).toContain("watch_id");
    expect(watchTasks.description).toContain("fired_immediately");
    expect(unwatch.description.toLowerCase()).toContain("idempotent");
  });
});

describe("watch_tasks handler", () => {
  it("forwards caller identity, ids and the default mode", async () => {
    const { services, watchCalls } = fakeServices();
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: ["task_1", "task_2"] });

    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0]).toEqual({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "watch_1",
      fired_immediately: false,
    });
  });

  it("passes an explicit valid mode through", async () => {
    const { services, watchCalls } = fakeServices();
    const { watchTasks } = tools(services);

    await watchTasks.handler({ task_ids: ["task_1"], mode: "any" });

    expect(watchCalls[0]?.mode).toBe("any");
  });

  it("falls back to 'all' when mode is not a known mode", async () => {
    const { services, watchCalls } = fakeServices();
    const { watchTasks } = tools(services);

    await watchTasks.handler({ task_ids: ["task_1"], mode: "eventually" });
    await watchTasks.handler({ task_ids: ["task_1"], mode: 7 });

    expect(watchCalls.map((c) => c.mode)).toEqual(["all", "all"]);
  });

  it("trims reason, and drops a blank one", async () => {
    const { services, watchCalls } = fakeServices();
    const { watchTasks } = tools(services);

    await watchTasks.handler({ task_ids: ["task_1"], reason: "  need the diff  " });
    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    await watchTasks.handler({ task_ids: ["task_1"], reason: 42 });

    expect(watchCalls.map((c) => c.reason)).toEqual([
      "need the diff",
      undefined,
      undefined,
    ]);
  });

  it("keeps only the string entries of task_ids", async () => {
    const { services, watchCalls } = fakeServices();
    const { watchTasks } = tools(services);

    await watchTasks.handler({ task_ids: ["task_1", 2, null, "task_3", undefined] });

    expect(watchCalls[0]?.taskIds).toEqual(["task_1", "task_3"]);
  });

  it("reports fired_immediately from the service verbatim", async () => {
    const { services } = fakeServices({
      watchTasks: async () => ({ watchId: "watch_9", firedImmediately: true }),
    });
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "watch_9",
      fired_immediately: true,
    });
  });

  it.each([
    ["an empty array", { task_ids: [] }],
    ["a non-array", { task_ids: "task_1" }],
    ["a missing field", {}],
    ["an array with no strings", { task_ids: [1, 2] }],
  ])("rejects %s of task_ids without calling the service", async (_label, input) => {
    const { services, watchCalls } = fakeServices();
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(watchCalls).toHaveLength(0);
  });

  it("refuses to register a watch outside a session context", async () => {
    const { services, watchCalls } = fakeServices();
    const { watchTasks } = tools(services, { agentId: "agent_a" });

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: expect.stringContaining("session context"),
    });
    expect(watchCalls).toHaveLength(0);
  });

  it.each([
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("task already terminal"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("watch_7"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
  ])("maps %s to the %s code", async (_label, thrown, code) => {
    const { services } = fakeServices({
      watchTasks: async () => {
        throw thrown;
      },
    });
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: code,
      message: (thrown as Error).message,
    });
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    const { services } = fakeServices({
      watchTasks: async () => {
        throw "pg died";
      },
    });
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({ error: "watch_error", message: "pg died" });
  });
});

describe("unwatch handler", () => {
  it("cancels by id and reports ok", async () => {
    const { services, unwatchCalls } = fakeServices();
    const { unwatch } = tools(services);

    const result = await unwatch.handler({ watch_id: "watch_1" });

    expect(unwatchCalls).toEqual([
      { callerAgentId: "agent_a", watchId: "watch_1" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["an empty string", { watch_id: "" }],
    ["a non-string", { watch_id: 12 }],
    ["a missing field", {}],
  ])("rejects %s of watch_id without calling the service", async (_label, input) => {
    const { services, unwatchCalls } = fakeServices();
    const { unwatch } = tools(services);

    const result = await unwatch.handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(unwatchCalls).toHaveLength(0);
  });

  it("maps a service error class to its code", async () => {
    const { services } = fakeServices({
      unwatch: async () => {
        throw new WatchNotFoundError("watch_404");
      },
    });
    const { unwatch } = tools(services);

    const result = await unwatch.handler({ watch_id: "watch_404" });

    expect(result.content).toMatchObject({ error: "watch_not_found" });
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    const { services } = fakeServices({
      unwatch: async () => {
        throw 500;
      },
    });
    const { unwatch } = tools(services);

    const result = await unwatch.handler({ watch_id: "watch_1" });

    expect(result.content).toEqual({ error: "watch_error", message: "500" });
  });

  it("does not require a session context", async () => {
    const { services, unwatchCalls } = fakeServices();
    const { unwatch } = tools(services, { agentId: "agent_a" });

    const result = await unwatch.handler({ watch_id: "watch_1" });

    expect(result.isError).toBeFalsy();
    expect(unwatchCalls).toHaveLength(1);
  });
});
