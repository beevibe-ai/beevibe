/**
 * watch_tasks + unwatch MCP tools — unit tests with vitest fakes.
 *
 * Both handlers are thin adapters, so what's worth pinning is the thin
 * part: the input coercion that happens before WatchService is called
 * (task_ids filtering, mode defaulting, the sessionId precondition) and
 * the error-class → wire-code mapping, which is the only thing telling
 * a calling agent "you're not allowed to watch that" apart from "the
 * DB fell over".
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
import type { AgentTool } from "./types.js";

const AGENT_ID = "agent_team";
const SESSION_ID = "sess_caller";

interface HarnessOpts {
  ctx?: Partial<WatchToolContext>;
  watchThrows?: unknown;
  unwatchThrows?: unknown;
  firedImmediately?: boolean;
}

function harness(opts: HarnessOpts = {}) {
  const watchService = {
    watchTasks: vi.fn(async () => {
      if (opts.watchThrows !== undefined) throw opts.watchThrows;
      return {
        watchId: "watch_1",
        firedImmediately: opts.firedImmediately ?? false,
      };
    }),
    unwatch: vi.fn(async () => {
      if (opts.unwatchThrows !== undefined) throw opts.unwatchThrows;
    }),
  } as unknown as WatchService;

  const tools = buildWatchTools(
    { agentId: AGENT_ID, sessionId: SESSION_ID, ...opts.ctx },
    { watchService },
  );
  const byName = (name: string): AgentTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not built`);
    return t;
  };
  return {
    tools,
    watchService,
    watchTasks: byName("watch_tasks"),
    unwatch: byName("unwatch"),
  };
}

describe("buildWatchTools", () => {
  it("builds both tools, watch_tasks first", () => {
    const { tools } = harness();
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises every supported mode in the schema enum", () => {
    const { watchTasks } = harness();
    const props = watchTasks.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.mode!.enum).toEqual([...TASK_WATCH_MODES]);
    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    expect(props.task_ids).toMatchObject({ type: "array", minItems: 1 });
  });
});

describe("watch_tasks", () => {
  it("forwards caller identity, task ids, mode and reason to the service", async () => {
    const { watchTasks, watchService } = harness();
    const res = await watchTasks.handler({
      task_ids: ["task_a", "task_b"],
      mode: "any",
      reason: "  need the first result  ",
    });
    expect(watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: "need the first result",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "watch_1", fired_immediately: false });
  });

  it("reports fired_immediately when the tasks were already terminal", async () => {
    const { watchTasks } = harness({ firedImmediately: true });
    const res = await watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.content.fired_immediately).toBe(true);
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    for (const mode of [undefined, "some", "ALL", 1, null]) {
      const { watchTasks, watchService } = harness();
      await watchTasks.handler({ task_ids: ["task_a"], mode });
      expect(watchService.watchTasks).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "all" }),
      );
    }
  });

  it("drops non-string entries from task_ids", async () => {
    const { watchTasks, watchService } = harness();
    await watchTasks.handler({ task_ids: ["task_a", 2, null, "task_b", {}] });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_a", "task_b"] }),
    );
  });

  it.each([
    ["omitted", undefined],
    ["an empty array", []],
    ["a non-array", "task_a"],
    ["all non-strings", [1, null]],
  ])("rejects task_ids that are %s without calling the service", async (_l, task_ids) => {
    const { watchTasks, watchService } = harness();
    const res = await watchTasks.handler({ task_ids });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(String(res.content.message)).toContain("task_ids");
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("omits a blank or non-string reason instead of forwarding an empty note", async () => {
    for (const reason of [undefined, "", "   ", 7]) {
      const { watchTasks, watchService } = harness();
      await watchTasks.handler({ task_ids: ["task_a"], reason });
      expect(watchService.watchTasks).toHaveBeenCalledWith(
        expect.objectContaining({ reason: undefined }),
      );
    }
  });

  it("refuses to register a watch outside a session context", async () => {
    const { watchTasks, watchService } = harness({ ctx: { sessionId: undefined } });
    const res = await watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(String(res.content.message)).toContain("session context");
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("checks task_ids before the session precondition", async () => {
    // Both guards return watch_validation, so the only way to tell them
    // apart is the message — pin the order so the agent gets the more
    // actionable complaint first.
    const { watchTasks } = harness({ ctx: { sessionId: undefined } });
    const res = await watchTasks.handler({ task_ids: [] });
    expect(String(res.content.message)).toContain("task_ids");
  });
});

describe("unwatch", () => {
  it("cancels by id and reports ok", async () => {
    const { unwatch, watchService } = harness();
    const res = await unwatch.handler({ watch_id: "watch_1" });
    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "watch_1",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
  });

  it("works without a session context — unlike watch_tasks", async () => {
    const { unwatch } = harness({ ctx: { sessionId: undefined } });
    const res = await unwatch.handler({ watch_id: "watch_1" });
    expect(res.content).toEqual({ ok: true });
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["a non-string", 3],
  ])("rejects a watch_id that is %s", async (_l, watch_id) => {
    const { unwatch, watchService } = harness();
    const res = await unwatch.handler({ watch_id });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  it.each([
    ["watch_auth", new WatchAuthError("task task_x is not in your chain")],
    ["watch_validation", new WatchValidationError("task_ids must be non-empty")],
    ["watch_not_found", new WatchNotFoundError("watch_9")],
    ["watch_error", new Error("connection terminated")],
  ])("maps a thrown %s to its wire code on both tools", async (code, err) => {
    const watch = harness({ watchThrows: err });
    const registered = await watch.watchTasks.handler({ task_ids: ["task_a"] });
    expect(registered.isError).toBe(true);
    expect(registered.content.error).toBe(code);
    expect(registered.content.message).toBe(err.message);

    const cancel = harness({ unwatchThrows: err });
    const cancelled = await cancel.unwatch.handler({ watch_id: "watch_9" });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content.error).toBe(code);
  });

  it("stringifies a non-Error throw under the generic code", async () => {
    const { watchTasks } = harness({ watchThrows: "pool drained" });
    const res = await watchTasks.handler({ task_ids: ["task_a"] });
    expect(res.content).toEqual({
      error: "watch_error",
      message: "pool drained",
    });
  });
});
