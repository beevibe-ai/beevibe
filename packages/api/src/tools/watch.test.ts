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
  opts: {
    watchResult?: { watchId: string; firedImmediately: boolean };
    watchThrows?: unknown;
    unwatchThrows?: unknown;
  } = {},
): Harness {
  const watchCalls: Array<Record<string, unknown>> = [];
  const unwatchCalls: Array<Record<string, unknown>> = [];

  const watchService = {
    watchTasks: vi.fn(async (input: Record<string, unknown>) => {
      if (opts.watchThrows) throw opts.watchThrows;
      watchCalls.push(input);
      return opts.watchResult ?? { watchId: "watch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: Record<string, unknown>) => {
      if (opts.unwatchThrows) throw opts.unwatchThrows;
      unwatchCalls.push(input);
    }),
  } as unknown as WatchService;

  return { services: { watchService }, watchCalls, unwatchCalls };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function tools(h: Harness, ctx: WatchToolContext = CTX) {
  const built = buildWatchTools(ctx, h.services);
  const watchTasks = built.find((t) => t.name === "watch_tasks")!;
  const unwatch = built.find((t) => t.name === "unwatch")!;
  return { built, watchTasks, unwatch };
}

describe("watch tools", () => {
  describe("descriptors", () => {
    it("builds exactly watch_tasks and unwatch, in that order", () => {
      const { built } = tools(harness());
      expect(built.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
    });

    it("declares the required inputs for each tool", () => {
      const { watchTasks, unwatch } = tools(harness());
      expect(watchTasks.schema.required).toEqual(["task_ids"]);
      expect(unwatch.schema.required).toEqual(["watch_id"]);
    });

    it("advertises both fire modes on the mode enum", () => {
      const { watchTasks } = tools(harness());
      const props = watchTasks.schema.properties as Record<
        string,
        { enum?: string[] }
      >;
      expect(props.mode?.enum).toEqual(["all", "any"]);
    });
  });

  describe("watch_tasks", () => {
    it("forwards caller identity, task ids, mode and reason to the service", async () => {
      const h = harness();
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({
        task_ids: ["task_1", "task_2"],
        mode: "any",
        reason: "need the build result",
      });

      expect(h.watchCalls[0]).toEqual({
        callerAgentId: "agent_a",
        callerSessionId: "sess_1",
        taskIds: ["task_1", "task_2"],
        mode: "any",
        reason: "need the build result",
      });
      expect(result.isError).toBeFalsy();
    });

    it("maps the service result onto the wire shape", async () => {
      const h = harness({
        watchResult: { watchId: "watch_xyz", firedImmediately: true },
      });
      const { watchTasks } = tools(h);

      const result = await watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.content).toEqual({
        watch_id: "watch_xyz",
        fired_immediately: true,
      });
    });

    it("defaults mode to 'all'", async () => {
      const h = harness();
      await tools(h).watchTasks.handler({ task_ids: ["task_1"] });

      expect(h.watchCalls[0]?.mode).toBe("all");
    });

    it.each([
      ["an unknown mode", "eventually"],
      ["a non-string mode", 1],
      ["null", null],
    ])("falls back to 'all' for %s", async (_label, mode) => {
      const h = harness();
      await tools(h).watchTasks.handler({ task_ids: ["task_1"], mode });

      expect(h.watchCalls[0]?.mode).toBe("all");
    });

    it("accepts 'any' as an explicit mode", async () => {
      const h = harness();
      await tools(h).watchTasks.handler({ task_ids: ["task_1"], mode: "any" });

      expect(h.watchCalls[0]?.mode).toBe("any");
    });

    it("trims the reason and drops a blank one", async () => {
      const h = harness();
      const { watchTasks } = tools(h);

      await watchTasks.handler({ task_ids: ["t1"], reason: "  why  " });
      await watchTasks.handler({ task_ids: ["t1"], reason: "   " });
      await watchTasks.handler({ task_ids: ["t1"], reason: 5 });

      expect(h.watchCalls[0]?.reason).toBe("why");
      expect(h.watchCalls[1]?.reason).toBeUndefined();
      expect(h.watchCalls[2]?.reason).toBeUndefined();
    });

    it("filters non-string entries out of task_ids", async () => {
      const h = harness();
      await tools(h).watchTasks.handler({
        task_ids: ["task_1", 2, null, "task_3", undefined],
      });

      expect(h.watchCalls[0]?.taskIds).toEqual(["task_1", "task_3"]);
    });

    it.each([
      ["an empty array", []],
      ["an array with no strings", [1, null, {}]],
      ["a non-array", "task_1"],
      ["a missing value", undefined],
    ])("rejects %s without calling the service", async (_label, task_ids) => {
      const h = harness();
      const result = await tools(h).watchTasks.handler({ task_ids });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(h.watchCalls).toHaveLength(0);
    });

    it("refuses to register a watch outside a session context", async () => {
      const h = harness();
      const { watchTasks } = tools(h, { agentId: "agent_a" });

      const result = await watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(String(result.content.message)).toContain("session context");
      expect(h.watchCalls).toHaveLength(0);
    });

    it.each([
      ["WatchAuthError", new WatchAuthError("not your session"), "watch_auth"],
      [
        "WatchValidationError",
        new WatchValidationError("task_ids must be non-empty"),
        "watch_validation",
      ],
      ["WatchNotFoundError", new WatchNotFoundError("watch_9"), "watch_not_found"],
      ["a plain Error", new Error("pg down"), "watch_error"],
      ["a non-Error throw", "kaboom", "watch_error"],
    ])("maps %s to the %s code", async (_label, thrown, code) => {
      const h = harness({ watchThrows: thrown });
      const result = await tools(h).watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code });
      expect(typeof result.content.message).toBe("string");
    });

    it("carries the thrown message through to the agent", async () => {
      const h = harness({ watchThrows: new WatchAuthError("not your session") });
      const result = await tools(h).watchTasks.handler({ task_ids: ["task_1"] });

      expect(result.content.message).toBe("not your session");
    });
  });

  describe("unwatch", () => {
    it("forwards the caller agent and watch id", async () => {
      const h = harness();
      const result = await tools(h).unwatch.handler({ watch_id: "watch_1" });

      expect(h.unwatchCalls[0]).toEqual({
        callerAgentId: "agent_a",
        watchId: "watch_1",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual({ ok: true });
    });

    it.each([
      ["an empty string", ""],
      ["a non-string", 12],
      ["a missing value", undefined],
    ])("rejects %s without calling the service", async (_label, watch_id) => {
      const h = harness();
      const result = await tools(h).unwatch.handler({ watch_id });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
      expect(h.unwatchCalls).toHaveLength(0);
    });

    it.each([
      ["WatchAuthError", new WatchAuthError("not yours"), "watch_auth"],
      ["WatchValidationError", new WatchValidationError("bad"), "watch_validation"],
      ["WatchNotFoundError", new WatchNotFoundError("watch_9"), "watch_not_found"],
      ["a plain Error", new Error("pg down"), "watch_error"],
      ["a non-Error throw", 500, "watch_error"],
    ])("maps %s to the %s code", async (_label, thrown, code) => {
      const h = harness({ unwatchThrows: thrown });
      const result = await tools(h).unwatch.handler({ watch_id: "watch_1" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code });
    });

    it("stays available outside a session context — it needs only the agent", async () => {
      const h = harness();
      const { unwatch } = tools(h, { agentId: "agent_a" });

      const result = await unwatch.handler({ watch_id: "watch_1" });

      expect(result.isError).toBeFalsy();
      expect(h.unwatchCalls).toHaveLength(1);
    });
  });
});
