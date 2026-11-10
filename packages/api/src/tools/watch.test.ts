/**
 * watch_tasks + unwatch tools — unit tests with vitest fakes (no DB).
 *
 * Both tools are thin adapters over WatchService: the service owns the
 * auth check, the insert and the already-terminal race. What lives *here*
 * is input coercion (which `task_ids` survive, how `mode`/`reason`
 * default) and the error-class → error-code mapping. Those are the two
 * things a caller branches on, so they're what these tests pin.
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

// ── Fakes ────────────────────────────────────────────────────────────────

function buildServices(
  overrides: {
    watchTasks?: WatchService["watchTasks"];
    unwatch?: WatchService["unwatch"];
  } = {},
) {
  const watchTasks =
    overrides.watchTasks ??
    vi.fn(async () => ({ watchId: "tw_1", firedImmediately: false }));
  const unwatch = overrides.unwatch ?? vi.fn(async () => {});
  const watchService = { watchTasks, unwatch } as unknown as WatchService;
  return { watchService, watchTasks, unwatch };
}

const ctx: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" };

function tools(
  services: { watchService: WatchService },
  context: WatchToolContext = ctx,
) {
  const built = buildWatchTools(context, services);
  const byName = (name: string): AgentTool => {
    const t = built.find((x) => x.name === name);
    if (!t) throw new Error(`no such tool: ${name}`);
    return t;
  };
  return { built, watchTasks: byName("watch_tasks"), unwatch: byName("unwatch") };
}

// ── Assembly ─────────────────────────────────────────────────────────────

describe("buildWatchTools", () => {
  it("returns exactly watch_tasks + unwatch", () => {
    const services = buildServices();
    const names = buildWatchTools(ctx, services)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["unwatch", "watch_tasks"]);
  });

  it("exposes the agent-facing schemas", () => {
    const services = buildServices();
    const { watchTasks, unwatch } = tools(services);

    expect(watchTasks.schema.required).toEqual(["task_ids"]);
    expect(unwatch.schema.required).toEqual(["watch_id"]);
    // The mode enum is the agent's only hint at the fire conditions, so
    // it has to stay in sync with TASK_WATCH_MODES.
    const props = watchTasks.schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.mode?.enum).toEqual(["all", "any"]);
  });
});

// ── watch_tasks ──────────────────────────────────────────────────────────

describe("watch_tasks handler", () => {
  it("delegates to watchService with the caller's agent + session ids", async () => {
    const services = buildServices();
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: ["task_1", "task_2"] });

    expect(services.watchTasks).toHaveBeenCalledTimes(1);
    expect(services.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      watch_id: "tw_1",
      fired_immediately: false,
    });
  });

  it("passes fired_immediately through when the condition was already met", async () => {
    const services = buildServices({
      watchTasks: vi.fn(async () => ({
        watchId: "tw_hot",
        firedImmediately: true,
      })) as unknown as WatchService["watchTasks"],
    });
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toEqual({
      watch_id: "tw_hot",
      fired_immediately: true,
    });
  });

  it("defaults mode to 'all' and honours an explicit 'any'", async () => {
    const services = buildServices();
    const { watchTasks } = tools(services);

    await watchTasks.handler({ task_ids: ["task_1"], mode: "any" });
    expect(
      vi.mocked(services.watchTasks).mock.calls[0]?.[0],
    ).toMatchObject({ mode: "any" });

    // An unrecognised mode is not an error — it silently falls back to
    // "all", the conservative choice (wait for everything).
    await watchTasks.handler({ task_ids: ["task_1"], mode: "whenever" });
    expect(
      vi.mocked(services.watchTasks).mock.calls[1]?.[0],
    ).toMatchObject({ mode: "all" });
  });

  it("drops non-string entries from task_ids", async () => {
    const services = buildServices();
    const { watchTasks } = tools(services);

    await watchTasks.handler({
      task_ids: ["task_1", 42, null, "task_2", { id: "task_3" }],
    });

    expect(
      vi.mocked(services.watchTasks).mock.calls[0]?.[0],
    ).toMatchObject({ taskIds: ["task_1", "task_2"] });
  });

  it("trims reason and omits it when blank", async () => {
    const services = buildServices();
    const { watchTasks } = tools(services);

    await watchTasks.handler({
      task_ids: ["task_1"],
      reason: "  resume the migration  ",
    });
    expect(
      vi.mocked(services.watchTasks).mock.calls[0]?.[0],
    ).toMatchObject({ reason: "resume the migration" });

    await watchTasks.handler({ task_ids: ["task_1"], reason: "   " });
    expect(
      vi.mocked(services.watchTasks).mock.calls[1]?.[0],
    ).toMatchObject({ reason: undefined });
  });

  it("rejects an empty task_ids array without calling the service", async () => {
    const services = buildServices();
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: [] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "watch_validation" });
    expect(services.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects task_ids that isn't an array, or holds no strings", async () => {
    const services = buildServices();
    const { watchTasks } = tools(services);

    for (const task_ids of ["task_1", undefined, 7, { 0: "task_1" }, [1, 2]]) {
      const result = await watchTasks.handler({ task_ids });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "watch_validation" });
    }
    expect(services.watchTasks).not.toHaveBeenCalled();
  });

  it("refuses to register a watch with no session context", async () => {
    // Without a session id the service can't identify the waiter, so the
    // adapter stops before calling it.
    const services = buildServices();
    const { watchTasks } = tools(services, { agentId: "agent_a" });

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(services.watchTasks).not.toHaveBeenCalled();
  });
});

// ── unwatch ──────────────────────────────────────────────────────────────

describe("unwatch handler", () => {
  it("delegates to watchService.unwatch and reports ok", async () => {
    const services = buildServices();
    const { unwatch } = tools(services);

    const result = await unwatch.handler({ watch_id: "tw_1" });

    expect(services.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "tw_1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ ok: true });
  });

  it("rejects a missing or non-string watch_id without calling the service", async () => {
    const services = buildServices();
    const { unwatch } = tools(services);

    for (const watch_id of ["", undefined, 7, null, {}]) {
      const result = await unwatch.handler({ watch_id });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
    }
    expect(services.unwatch).not.toHaveBeenCalled();
  });
});

// ── Error mapping (shared by both handlers) ──────────────────────────────

describe("WatchService error → tool error code", () => {
  // The code is the stable identifier the calling agent branches on, so
  // each service error class has to keep landing on its own code.
  const cases: Array<[string, unknown, string]> = [
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("mode must be all|any"),
      "watch_validation",
    ],
    ["WatchNotFoundError", new WatchNotFoundError("tw_404"), "watch_not_found"],
    ["a plain Error", new Error("pool exhausted"), "watch_error"],
    ["a non-Error throw", "kaboom", "watch_error"],
  ];

  it.each(cases)("maps %s on watch_tasks", async (_label, thrown, code) => {
    const services = buildServices({
      watchTasks: vi.fn(async () => {
        throw thrown;
      }) as unknown as WatchService["watchTasks"],
    });
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
    // The human-readable half is always carried through.
    expect(typeof result.content.message).toBe("string");
    expect(result.content.message).not.toBe("");
  });

  it.each(cases)("maps %s on unwatch", async (_label, thrown, code) => {
    const services = buildServices({
      unwatch: vi.fn(async () => {
        throw thrown;
      }) as unknown as WatchService["unwatch"],
    });
    const { unwatch } = tools(services);

    const result = await unwatch.handler({ watch_id: "tw_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: code });
  });

  it("stringifies a non-Error throw into the message", async () => {
    const services = buildServices({
      watchTasks: vi.fn(async () => {
        throw { code: 42 };
      }) as unknown as WatchService["watchTasks"],
    });
    const { watchTasks } = tools(services);

    const result = await watchTasks.handler({ task_ids: ["task_1"] });

    expect(result.content).toMatchObject({
      error: "watch_error",
      message: "[object Object]",
    });
  });
});
