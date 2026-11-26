/**
 * watch_tasks + unwatch handler tests.
 *
 * Both tools are thin adapters over WatchService: the service owns the
 * auth check, the insert and the already-terminal race. What lives here
 * is the adapter's own logic — input coercion (which is what keeps a
 * malformed `task_ids` from reaching the service), the mode default,
 * and the error-class → error-code mapping agents branch on. A fake
 * WatchService keeps all of it off Postgres.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchValidationError,
  type WatchService,
  type WatchTasksInput,
  type UnwatchInput,
} from "@beevibe/core/services/watch-service";
import { buildWatchTools, type WatchToolContext } from "./watch.js";

interface Fake {
  watchService: WatchService;
  watchCalls: WatchTasksInput[];
  unwatchCalls: UnwatchInput[];
}

/** `throws` is raised by both methods, so one option covers either path. */
function fakeWatchService(opts: { throws?: unknown } = {}): Fake {
  const watchCalls: WatchTasksInput[] = [];
  const unwatchCalls: UnwatchInput[] = [];
  const watchService = {
    watchTasks: vi.fn(async (input: WatchTasksInput) => {
      if (opts.throws) throw opts.throws;
      watchCalls.push(input);
      return { watchId: "twatch_1", firedImmediately: false };
    }),
    unwatch: vi.fn(async (input: UnwatchInput) => {
      if (opts.throws) throw opts.throws;
      unwatchCalls.push(input);
    }),
  } as unknown as WatchService;
  return { watchService, watchCalls, unwatchCalls };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" };

function watchTasksTool(fake: Fake, ctx = CTX) {
  const tool = buildWatchTools(ctx, { watchService: fake.watchService })[0];
  if (!tool) throw new Error("watch_tasks tool missing");
  return tool;
}

function unwatchTool(fake: Fake, ctx = CTX) {
  const tool = buildWatchTools(ctx, { watchService: fake.watchService })[1];
  if (!tool) throw new Error("unwatch tool missing");
  return tool;
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const fake = fakeWatchService();
    const tools = buildWatchTools(CTX, { watchService: fake.watchService });
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("declares task_ids and watch_id as the required inputs", () => {
    const fake = fakeWatchService();
    expect(watchTasksTool(fake).schema.required).toEqual(["task_ids"]);
    expect(unwatchTool(fake).schema.required).toEqual(["watch_id"]);
  });

  it("offers exactly the two documented fire modes", () => {
    const fake = fakeWatchService();
    const props = watchTasksTool(fake).schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
  });
});

describe("watch_tasks handler", () => {
  it("passes caller identity from context, not from input", async () => {
    const fake = fakeWatchService();
    // An agent that tries to register a watch as somebody else must not
    // be able to: the ids are read from the resolved context only.
    const result = await watchTasksTool(fake).handler({
      task_ids: ["task_1"],
      callerAgentId: "agent_evil",
      callerSessionId: "ses_evil",
    });

    expect(fake.watchCalls).toHaveLength(1);
    expect(fake.watchCalls[0]).toMatchObject({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["task_1"],
    });
    expect(result.isError).toBeFalsy();
  });

  it("returns the service's watch id and fired_immediately flag", async () => {
    const fake = fakeWatchService();
    const result = await watchTasksTool(fake).handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "twatch_1",
      fired_immediately: false,
    });
  });

  it("defaults mode to 'all' when omitted", async () => {
    const fake = fakeWatchService();
    await watchTasksTool(fake).handler({ task_ids: ["task_1"] });
    expect(fake.watchCalls[0]?.mode).toBe("all");
  });

  it("defaults mode to 'all' when the value is not a known mode", async () => {
    const fake = fakeWatchService();
    // "first" reads plausible but isn't in TASK_WATCH_MODES; silently
    // widening it to "any" would fire the watch earlier than asked.
    await watchTasksTool(fake).handler({ task_ids: ["task_1"], mode: "first" });
    expect(fake.watchCalls[0]?.mode).toBe("all");
  });

  it("honours an explicit 'any' mode", async () => {
    const fake = fakeWatchService();
    await watchTasksTool(fake).handler({ task_ids: ["task_1"], mode: "any" });
    expect(fake.watchCalls[0]?.mode).toBe("any");
  });

  it("trims the reason and drops a blank one", async () => {
    const fake = fakeWatchService();
    const tool = watchTasksTool(fake);

    await tool.handler({ task_ids: ["task_1"], reason: "  need the diff  " });
    expect(fake.watchCalls[0]?.reason).toBe("need the diff");

    await tool.handler({ task_ids: ["task_1"], reason: "   " });
    expect(fake.watchCalls[1]?.reason).toBeUndefined();

    await tool.handler({ task_ids: ["task_1"], reason: 42 });
    expect(fake.watchCalls[2]?.reason).toBeUndefined();
  });

  it("keeps only the string entries of task_ids", async () => {
    const fake = fakeWatchService();
    await watchTasksTool(fake).handler({
      task_ids: ["task_1", 7, null, "task_2", { id: "task_3" }],
    });
    expect(fake.watchCalls[0]?.taskIds).toEqual(["task_1", "task_2"]);
  });

  it("rejects an empty task_ids array without calling the service", async () => {
    const fake = fakeWatchService();
    const result = await watchTasksTool(fake).handler({ task_ids: [] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(fake.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects task_ids that is not an array", async () => {
    const fake = fakeWatchService();
    const result = await watchTasksTool(fake).handler({ task_ids: "task_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(fake.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects task_ids whose entries are all non-strings", async () => {
    const fake = fakeWatchService();
    const result = await watchTasksTool(fake).handler({ task_ids: [1, 2] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(fake.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch with no session to wake", async () => {
    const fake = fakeWatchService();
    const tool = watchTasksTool(fake, { agentId: "agent_a" });
    const result = await tool.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(fake.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("validates the session context before touching the service", async () => {
    // Ordering matters: a sessionless caller with bad task_ids should get
    // the task_ids complaint first, since that is the fixable one.
    const fake = fakeWatchService();
    const tool = watchTasksTool(fake, { agentId: "agent_a" });
    const result = await tool.handler({ task_ids: [] });

    expect(result.content).toMatchObject({
      message: "task_ids must be a non-empty array of strings",
    });
  });
});

describe("unwatch handler", () => {
  it("delegates with the caller's agent id and the given watch id", async () => {
    const fake = fakeWatchService();
    const result = await unwatchTool(fake).handler({ watch_id: "twatch_1" });

    expect(fake.unwatchCalls).toEqual([
      { callerAgentId: "agent_a", watchId: "twatch_1" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id", async () => {
    const fake = fakeWatchService();
    const tool = unwatchTool(fake);

    for (const bad of [undefined, "", 7, null]) {
      const result = await tool.handler({ watch_id: bad });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(fake.watchService.unwatch).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  // The code is the agent-visible contract — it decides whether the agent
  // retries, re-reads its task ids, or gives up. Each service error class
  // has to keep its own code rather than collapsing into watch_error.
  const cases: Array<[string, unknown, string]> = [
    ["auth", new WatchAuthError("not your chain"), "watch_auth"],
    ["validation", new WatchValidationError("bad mode"), "watch_validation"],
    ["not found", new WatchNotFoundError("twatch_9"), "watch_not_found"],
    ["generic Error", new Error("pool exhausted"), "watch_error"],
    ["non-Error throw", "kaboom", "watch_error"],
  ];

  for (const [label, thrown, code] of cases) {
    it(`maps a thrown ${label} to ${code} on watch_tasks`, async () => {
      const fake = fakeWatchService({ throws: thrown });
      const result = await watchTasksTool(fake).handler({
        task_ids: ["task_1"],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code });
    });

    it(`maps a thrown ${label} to ${code} on unwatch`, async () => {
      const fake = fakeWatchService({ throws: thrown });
      const result = await unwatchTool(fake).handler({ watch_id: "twatch_1" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: code });
    });
  }

  it("carries the service's message through for the human reader", async () => {
    const fake = fakeWatchService({
      throws: new WatchAuthError("task(s) not dispatched in your chain: t_9"),
    });
    const result = await watchTasksTool(fake).handler({ task_ids: ["t_9"] });

    expect(result.content).toMatchObject({
      error: "watch_auth",
      message: "task(s) not dispatched in your chain: t_9",
    });
  });

  it("stringifies a non-Error throw rather than losing it", async () => {
    const fake = fakeWatchService({ throws: "kaboom" });
    const result = await unwatchTool(fake).handler({ watch_id: "twatch_1" });

    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "kaboom",
    });
  });
});
