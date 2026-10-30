/**
 * watch_tasks / unwatch tool tests.
 *
 * Both tools are thin adapters over WatchService, so what's worth locking
 * is the adapter's own logic: input coercion (task_ids filtering, mode
 * defaulting, reason trimming), the session-context requirement, and the
 * error-class → error-code mapping that gives agents something stable to
 * branch on.
 */
import { describe, expect, it, vi } from "vitest";
import { TASK_WATCH_MODES } from "@beevibe/core";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Harness {
  watchTasks: Record<string, unknown>[];
  unwatch: Record<string, unknown>[];
  services: { watchService: WatchService };
}

function harness(
  opts: { watchError?: unknown; unwatchError?: unknown } = {},
): Harness {
  const watchTasks: Record<string, unknown>[] = [];
  const unwatch: Record<string, unknown>[] = [];
  const watchService = {
    watchTasks: vi.fn(async (input: Record<string, unknown>) => {
      watchTasks.push(input);
      if (opts.watchError) throw opts.watchError;
      return { watchId: "twa_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: Record<string, unknown>) => {
      unwatch.push(input);
      if (opts.unwatchError) throw opts.unwatchError;
    }),
  } as unknown as WatchService;
  return { watchTasks, unwatch, services: { watchService } };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" };

function build(
  opts?: Parameters<typeof harness>[0],
  ctx: WatchToolContext = CTX,
) {
  const h = harness(opts);
  const tools = buildWatchTools(ctx, h.services);
  const byName = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return tool;
  };
  return { ...h, tools, watchTool: byName("watch_tasks"), unwatchTool: byName("unwatch") };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks then unwatch", () => {
    const { tools } = build();
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the domain's mode list in the schema enum", () => {
    const { watchTool } = build();
    const props = watchTool.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual([...TASK_WATCH_MODES]);
    expect(watchTool.schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("passes caller identity, task ids, mode and reason to the service", async () => {
    const { watchTool, watchTasks } = build();
    const result = await watchTool.handler({
      task_ids: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "  need both reviews  ",
    });

    expect(watchTasks[0]).toEqual({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["tsk_1", "tsk_2"],
      mode: "any",
      reason: "need both reviews",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ watch_id: "twa_1", fired_immediately: false });
  });

  it("defaults mode to 'all' when absent or not a known mode", async () => {
    for (const mode of [undefined, "", "sometimes", 1]) {
      const { watchTool, watchTasks } = build();
      await watchTool.handler({ task_ids: ["tsk_1"], mode });
      expect(watchTasks[0]?.mode).toBe("all");
    }
  });

  it("omits a blank or non-string reason instead of forwarding it", async () => {
    for (const reason of [undefined, "", "   ", 5]) {
      const { watchTool, watchTasks } = build();
      await watchTool.handler({ task_ids: ["tsk_1"], reason });
      expect(watchTasks[0]?.reason).toBeUndefined();
    }
  });

  it("drops non-string entries from task_ids", async () => {
    const { watchTool, watchTasks } = build();
    await watchTool.handler({ task_ids: ["tsk_1", 2, null, "tsk_3"] });
    expect(watchTasks[0]?.taskIds).toEqual(["tsk_1", "tsk_3"]);
  });

  it.each([
    ["absent", undefined],
    ["not an array", "tsk_1"],
    ["empty", []],
    ["all non-strings", [1, null]],
  ])("rejects task_ids that are %s without calling the service", async (_l, task_ids) => {
    const { watchTool, services } = build();
    const result = await watchTool.handler({ task_ids });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(services.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch with no session context", async () => {
    const { watchTool, services } = build(undefined, { agentId: "agent_a" });
    const result = await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(services.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("reports fired_immediately when the condition was already met", async () => {
    const h = harness();
    (h.services.watchService.watchTasks as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ watchId: "twa_9", firedImmediately: true });
    const tool = buildWatchTools(CTX, h.services)[0]!;
    const result = await tool.handler({ task_ids: ["tsk_1"] });
    expect(result.content).toEqual({ watch_id: "twa_9", fired_immediately: true });
  });
});

describe("unwatch", () => {
  it("cancels by id and reports ok", async () => {
    const { unwatchTool, unwatch } = build();
    const result = await unwatchTool.handler({ watch_id: "twa_1" });
    expect(unwatch[0]).toEqual({ callerAgentId: "agent_a", watchId: "twa_1" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it.each([
    ["absent", undefined],
    ["blank", ""],
    ["not a string", 12],
  ])("rejects a watch_id that is %s", async (_l, watch_id) => {
    const { unwatchTool, services } = build();
    const result = await unwatchTool.handler({ watch_id });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(services.watchService.unwatch).not.toHaveBeenCalled();
  });
});

describe("service error → agent-facing code", () => {
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not yours"), "watch_auth"],
    ["WatchValidationError", new WatchValidationError("bad mode"), "watch_validation"],
    ["WatchNotFoundError", new WatchNotFoundError("twa_x"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
    ["a non-Error throw", "kaboom", "watch_error"],
  ];

  it.each(cases)("maps %s from watch_tasks to %s", async (_l, thrown, code) => {
    const { watchTool } = build({ watchError: thrown });
    const result = await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });

  it.each(cases)("maps %s from unwatch to %s", async (_l, thrown, code) => {
    const { unwatchTool } = build({ unwatchError: thrown });
    const result = await unwatchTool.handler({ watch_id: "twa_1" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });

  it("keeps the thrown message alongside the code", async () => {
    const { watchTool } = build({ watchError: new WatchAuthError("task tsk_9 not in chain") });
    const result = await watchTool.handler({ task_ids: ["tsk_9"] });
    expect(result.content).toMatchObject({
      error: "watch_auth",
      message: "task tsk_9 not in chain",
    });
  });

  it("stringifies a non-Error throw into the message", async () => {
    const { watchTool } = build({ watchError: { nope: true } });
    const result = await watchTool.handler({ task_ids: ["tsk_1"] });
    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "[object Object]",
    });
  });
});
