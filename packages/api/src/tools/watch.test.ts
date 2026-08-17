/**
 * watch_tasks + unwatch MCP tools — unit tests with a fake WatchService.
 *
 * Both tools are thin adapters: they coerce loose MCP input into the
 * service's typed arguments and map the service's four error classes
 * onto stable `error` codes. The service itself is exercised by
 * `core/src/services/watch-service.test.ts` against a real DB, so the
 * fake here only has to record what it was handed and throw on demand.
 *
 * What these tests pin is the adapter contract the agent sees: the
 * input coercion (non-string entries dropped, mode defaulting, reason
 * trimming), the session-context precondition, and the error-code
 * mapping — none of which the service-level suite covers.
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

const AGENT = "agent_team";
const SESSION = "sess_caller00001";

function makeService(overrides: Partial<WatchService> = {}) {
  return {
    watchTasks: vi.fn().mockResolvedValue({ watchId: "twatch_1", firedImmediately: false }),
    unwatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as WatchService & {
    watchTasks: ReturnType<typeof vi.fn>;
    unwatch: ReturnType<typeof vi.fn>;
  };
}

function build(
  ctx: Partial<WatchToolContext> = {},
  service = makeService(),
): { watch: AgentTool; unwatch: AgentTool; service: typeof service } {
  const tools = buildWatchTools(
    { agentId: AGENT, sessionId: SESSION, ...ctx },
    { watchService: service },
  );
  const watch = tools.find((t) => t.name === "watch_tasks")!;
  const unwatch = tools.find((t) => t.name === "unwatch")!;
  return { watch, unwatch, service };
}

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    const tools = buildWatchTools(
      { agentId: AGENT, sessionId: SESSION },
      { watchService: makeService() },
    );
    expect(tools.map((t) => t.name)).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises the three watch modes on the schema enum", () => {
    const { watch } = build();
    const schema = watch.schema as {
      properties: { mode: { enum: string[] }; task_ids: { minItems: number } };
      required: string[];
    };
    // The enum is the agent-facing contract; "all" and "any" are the
    // two documented in the description.
    expect(schema.properties.mode.enum).toContain("all");
    expect(schema.properties.mode.enum).toContain("any");
    expect(schema.properties.task_ids.minItems).toBe(1);
    expect(schema.required).toEqual(["task_ids"]);
  });
});

describe("watch_tasks", () => {
  it("passes task ids through and returns the service's watch id", async () => {
    const { watch, service } = build();
    const res = await watch.handler({ task_ids: ["task_a", "task_b"], mode: "any" });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "twatch_1", fired_immediately: false });
    expect(service.watchTasks).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      callerSessionId: SESSION,
      taskIds: ["task_a", "task_b"],
      mode: "any",
      reason: undefined,
    });
  });

  it("surfaces fired_immediately when the condition was already met", async () => {
    const service = makeService({
      watchTasks: vi.fn().mockResolvedValue({ watchId: "twatch_9", firedImmediately: true }),
    } as Partial<WatchService>);
    const { watch } = build({}, service);

    const res = await watch.handler({ task_ids: ["task_a"] });
    expect(res.content).toEqual({ watch_id: "twatch_9", fired_immediately: true });
  });

  it("defaults mode to 'all' when omitted or not a known mode", async () => {
    const { watch, service } = build();

    await watch.handler({ task_ids: ["task_a"] });
    expect(service.watchTasks.mock.calls[0]![0].mode).toBe("all");

    await watch.handler({ task_ids: ["task_a"], mode: "eventually" });
    expect(service.watchTasks.mock.calls[1]![0].mode).toBe("all");

    await watch.handler({ task_ids: ["task_a"], mode: 7 });
    expect(service.watchTasks.mock.calls[2]![0].mode).toBe("all");
  });

  it("trims reason, and drops it when blank", async () => {
    const { watch, service } = build();

    await watch.handler({ task_ids: ["task_a"], reason: "  need the diff  " });
    expect(service.watchTasks.mock.calls[0]![0].reason).toBe("need the diff");

    await watch.handler({ task_ids: ["task_a"], reason: "   " });
    expect(service.watchTasks.mock.calls[1]![0].reason).toBeUndefined();

    await watch.handler({ task_ids: ["task_a"], reason: 42 });
    expect(service.watchTasks.mock.calls[2]![0].reason).toBeUndefined();
  });

  it("filters non-string entries out of task_ids", async () => {
    const { watch, service } = build();
    await watch.handler({ task_ids: ["task_a", 5, null, "task_b", { id: "x" }] });

    expect(service.watchTasks.mock.calls[0]![0].taskIds).toEqual(["task_a", "task_b"]);
  });

  it("rejects a missing, non-array, or all-non-string task_ids", async () => {
    const { watch, service } = build();

    for (const input of [{}, { task_ids: "task_a" }, { task_ids: [] }, { task_ids: [1, 2] }]) {
      const res = await watch.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
      expect(res.content.message).toMatch(/non-empty array of strings/);
    }
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects the call when there is no session context", async () => {
    // The MCP transport binds sessionId per session; without it the
    // service has no waiter to wake, so the tool refuses rather than
    // registering an unwakeable watch.
    const { watch, service } = build({ sessionId: undefined });
    const res = await watch.handler({ task_ids: ["task_a"] });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(service.watchTasks).not.toHaveBeenCalled();
  });

  it.each([
    ["WatchAuthError", new WatchAuthError("not your session"), "watch_auth", "not your session"],
    [
      "WatchValidationError",
      new WatchValidationError("task_ids must be non-empty"),
      "watch_validation",
      "task_ids must be non-empty",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("twatch_missing"),
      "watch_not_found",
      "task_watch twatch_missing not found",
    ],
    ["plain Error", new Error("pg down"), "watch_error", "pg down"],
  ])("maps a thrown %s onto its error code", async (_label, thrown, code, message) => {
    const service = makeService({
      watchTasks: vi.fn().mockRejectedValue(thrown),
    } as Partial<WatchService>);
    const { watch } = build({}, service);

    const res = await watch.handler({ task_ids: ["task_a"] });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: code, message });
  });

  it("stringifies a non-Error throw", async () => {
    const service = makeService({
      watchTasks: vi.fn().mockRejectedValue("boom"),
    } as Partial<WatchService>);
    const { watch } = build({}, service);

    const res = await watch.handler({ task_ids: ["task_a"] });
    expect(res.content).toEqual({ error: "watch_error", message: "boom" });
  });
});

describe("unwatch", () => {
  it("cancels the watch and returns ok", async () => {
    const { unwatch, service } = build();
    const res = await unwatch.handler({ watch_id: "twatch_1" });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(service.unwatch).toHaveBeenCalledWith({
      callerAgentId: AGENT,
      watchId: "twatch_1",
    });
  });

  it("rejects a missing or non-string watch_id", async () => {
    const { unwatch, service } = build();

    for (const input of [{}, { watch_id: "" }, { watch_id: 12 }]) {
      const res = await unwatch.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
    }
    expect(service.unwatch).not.toHaveBeenCalled();
  });

  it("maps a thrown WatchNotFoundError onto watch_not_found", async () => {
    const service = makeService({
      unwatch: vi.fn().mockRejectedValue(new WatchNotFoundError("twatch_gone")),
    } as Partial<WatchService>);
    const { unwatch } = build({}, service);

    const res = await unwatch.handler({ watch_id: "twatch_gone" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_not_found",
      message: "task_watch twatch_gone not found",
    });
  });

  it("maps a thrown WatchAuthError onto watch_auth", async () => {
    const service = makeService({
      unwatch: vi.fn().mockRejectedValue(new WatchAuthError("watch does not belong to caller")),
    } as Partial<WatchService>);
    const { unwatch } = build({}, service);

    const res = await unwatch.handler({ watch_id: "twatch_other" });
    expect(res.content).toEqual({
      error: "watch_auth",
      message: "watch does not belong to caller",
    });
  });
});
