/**
 * watch_tasks + unwatch — unit tests with vitest fakes (no DB).
 *
 * Both tools are thin adapters: WatchService owns the authz check, the
 * insert, the already-terminal race fire, and the unwatch state machine
 * (covered by its own DB-backed suite). What's left here, and what these
 * tests pin, is the adapter's three jobs — coerce the raw MCP input,
 * refuse a call made without a session context, and map each service
 * error class onto its stable `error` code so agents can branch on it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";
import type { AgentTool, AgentToolResult } from "./types.js";

const AGENT_ID = "agent_team";
const SESSION_ID = "sess_caller";

function fakeWatchService(overrides: Partial<WatchService> = {}): WatchService {
  return {
    watchTasks: vi.fn(async () => ({ watchId: "tw_1", firedImmediately: false })),
    unwatch: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WatchService;
}

function build(
  watchService: WatchService,
  ctx: Partial<WatchToolContext> = {},
): AgentTool[] {
  return buildWatchTools(
    { agentId: AGENT_ID, sessionId: SESSION_ID, ...ctx },
    { watchService },
  );
}

function tool(tools: AgentTool[], name: string): AgentTool {
  const t = tools.find((candidate) => candidate.name === name);
  if (!t) throw new Error(`tool ${name} missing from set`);
  return t;
}

function callWatch(
  watchService: WatchService,
  input: Record<string, unknown>,
  ctx: Partial<WatchToolContext> = {},
): Promise<AgentToolResult> {
  return tool(build(watchService, ctx), "watch_tasks").handler(input);
}

function callUnwatch(
  watchService: WatchService,
  input: Record<string, unknown>,
): Promise<AgentToolResult> {
  return tool(build(watchService), "unwatch").handler(input);
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    expect(build(fakeWatchService()).map((t) => t.name)).toEqual([
      "watch_tasks",
      "unwatch",
    ]);
  });

  // The enum is generated from TASK_WATCH_MODES, so a mode added to the
  // domain constant has to show up in the agent-facing schema.
  it("advertises both fire modes in the watch_tasks schema", () => {
    const schema = tool(build(fakeWatchService()), "watch_tasks").schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.mode.enum.sort()).toEqual(["all", "any"]);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks — input coercion", () => {
  it("forwards the task ids, defaulting mode to 'all' and omitting reason", async () => {
    const watchService = fakeWatchService();
    const res = await callWatch(watchService, { task_ids: ["task_1", "task_2"] });

    expect(res.isError).toBeUndefined();
    expect(watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      callerSessionId: SESSION_ID,
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
  });

  it("honours an explicit 'any' mode", async () => {
    const watchService = fakeWatchService();
    await callWatch(watchService, { task_ids: ["task_1"], mode: "any" });

    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "any" }),
    );
  });

  // An LLM writing "either" or "first" shouldn't get a silent no-watch;
  // falling back to the stricter "all" is the safe default.
  it("falls back to 'all' for an unrecognized mode", async () => {
    const watchService = fakeWatchService();
    await callWatch(watchService, { task_ids: ["task_1"], mode: "either" });

    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("trims the reason and drops a blank one", async () => {
    const watchService = fakeWatchService();
    await callWatch(watchService, { task_ids: ["task_1"], reason: "  review the PR  " });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "review the PR" }),
    );

    await callWatch(watchService, { task_ids: ["task_1"], reason: "   " });
    expect(watchService.watchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });

  it("filters non-string entries out of task_ids", async () => {
    const watchService = fakeWatchService();
    await callWatch(watchService, { task_ids: ["task_1", 2, null, "task_3"] });

    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_1", "task_3"] }),
    );
  });

  it("returns the watch id and the immediate-fire flag", async () => {
    const watchService = fakeWatchService({
      watchTasks: vi.fn(async () => ({ watchId: "tw_42", firedImmediately: true })),
    });
    const res = await callWatch(watchService, { task_ids: ["task_1"] });

    expect(res.content).toEqual({ watch_id: "tw_42", fired_immediately: true });
  });
});

describe("watch_tasks — refusals", () => {
  it.each([
    ["an absent task_ids", {}],
    ["an empty array", { task_ids: [] }],
    ["a non-array", { task_ids: "task_1" }],
    ["an array with no strings in it", { task_ids: [1, 2] }],
  ])("refuses %s without calling the service", async (_label, input) => {
    const watchService = fakeWatchService();
    const res = await callWatch(watchService, input);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  // Without a session id there's no waiter to resume, so the watch would
  // insert and then never be able to wake anyone.
  it("refuses a call made outside a session context", async () => {
    const watchService = fakeWatchService();
    const res = await callWatch(
      watchService,
      { task_ids: ["task_1"] },
      { sessionId: undefined },
    );

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });
});

describe("unwatch", () => {
  it("forwards the watch id and reports ok", async () => {
    const watchService = fakeWatchService();
    const res = await callUnwatch(watchService, { watch_id: "tw_1" });

    expect(res.content).toEqual({ ok: true });
    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT_ID,
      watchId: "tw_1",
    });
  });

  it.each([
    ["an absent watch_id", {}],
    ["an empty watch_id", { watch_id: "" }],
    ["a non-string watch_id", { watch_id: 7 }],
  ])("refuses %s without calling the service", async (_label, input) => {
    const watchService = fakeWatchService();
    const res = await callUnwatch(watchService, input);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  // The codes are the agent-facing contract: an agent branches on
  // `error` to decide whether to retry, re-read the task, or give up.
  const cases: Array<[string, Error, string]> = [
    ["auth", new WatchAuthError("task task_9 is not in your chain"), "watch_auth"],
    ["validation", new WatchValidationError("mode must be all|any"), "watch_validation"],
    ["not-found", new WatchNotFoundError("tw_9"), "watch_not_found"],
    ["generic Error", new Error("pool exhausted"), "watch_error"],
  ];

  it.each(cases)("maps a %s failure from watch_tasks", async (_label, err, code) => {
    const watchService = fakeWatchService({
      watchTasks: vi.fn(async () => {
        throw err;
      }),
    });
    const res = await callWatch(watchService, { task_ids: ["task_1"] });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message: err.message });
  });

  it.each(cases)("maps a %s failure from unwatch", async (_label, err, code) => {
    const watchService = fakeWatchService({
      unwatch: vi.fn(async () => {
        throw err;
      }),
    });
    const res = await callUnwatch(watchService, { watch_id: "tw_1" });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message: err.message });
  });

  it("stringifies a non-Error throw", async () => {
    const watchService = fakeWatchService({
      watchTasks: vi.fn(async () => Promise.reject("nope")),
    });
    const res = await callWatch(watchService, { task_ids: ["task_1"] });

    expect(res.content).toEqual({ error: "watch_error", message: "nope" });
  });
});
