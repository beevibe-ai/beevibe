/**
 * watch_tasks + unwatch — unit tests with vitest fakes (no DB).
 *
 * Both tools are thin adapters over WatchService: the service owns the
 * auth check, the insert, and the already-terminal race. What lives
 * *here* is the input coercion (what the agent typed vs. what the
 * service contract requires) and the error-code mapping, so that is
 * what these tests pin.
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

function buildServices(overrides: Partial<WatchService> = {}) {
  const watchService = {
    watchTasks: vi.fn(async () => ({
      watchId: "twatch_1",
      firedImmediately: false,
    })),
    unwatch: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WatchService;
  return { services: { watchService }, watchService };
}

const ctx: WatchToolContext = { agentId: "agent_a", sessionId: "ses_1" };

/** Tools are closures over (ctx, services); pick one out by name. */
function tool(name: string, c: WatchToolContext, services: { watchService: WatchService }): AgentTool {
  const found = buildWatchTools(c, services).find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

// ── buildWatchTools ──────────────────────────────────────────────────────

describe("buildWatchTools", () => {
  it("returns exactly watch_tasks + unwatch", () => {
    const { services } = buildServices();
    const names = buildWatchTools(ctx, services).map((t) => t.name);
    expect(names).toEqual(["watch_tasks", "unwatch"]);
  });

  it("advertises both watch modes in the schema enum", () => {
    const { services } = buildServices();
    const schema = tool("watch_tasks", ctx, services).schema as {
      properties: { mode: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.mode.enum).toEqual(["all", "any"]);
    // task_ids is the only hard requirement — mode and reason default.
    expect(schema.required).toEqual(["task_ids"]);
  });
});

// ── watch_tasks ──────────────────────────────────────────────────────────

describe("watch_tasks", () => {
  it("registers the watch and returns the service's ids", async () => {
    const { services, watchService } = buildServices({
      watchTasks: vi.fn(async () => ({ watchId: "twatch_9", firedImmediately: true })),
    } as Partial<WatchService>);

    const res = await tool("watch_tasks", ctx, services).handler({
      task_ids: ["task_1", "task_2"],
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ watch_id: "twatch_9", fired_immediately: true });
    // mode defaults to "all" and the caller identity comes from ctx, not input.
    expect(watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "ses_1",
      taskIds: ["task_1", "task_2"],
      mode: "all",
      reason: undefined,
    });
  });

  it("passes mode 'any' through", async () => {
    const { services, watchService } = buildServices();
    await tool("watch_tasks", ctx, services).handler({
      task_ids: ["task_1"],
      mode: "any",
    });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "any" }),
    );
  });

  it("falls back to 'all' when mode is not a known mode", async () => {
    const { services, watchService } = buildServices();
    await tool("watch_tasks", ctx, services).handler({
      task_ids: ["task_1"],
      mode: "eventually",
    });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it("trims reason, and drops a blank one", async () => {
    const { services, watchService } = buildServices();
    const t = tool("watch_tasks", ctx, services);

    await t.handler({ task_ids: ["task_1"], reason: "  need the diff  " });
    expect(watchService.watchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "need the diff" }),
    );

    await t.handler({ task_ids: ["task_1"], reason: "   " });
    expect(watchService.watchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: undefined }),
    );

    await t.handler({ task_ids: ["task_1"], reason: 42 });
    expect(watchService.watchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });

  it("drops non-string entries from task_ids", async () => {
    const { services, watchService } = buildServices();
    await tool("watch_tasks", ctx, services).handler({
      task_ids: ["task_1", 7, null, "task_2"],
    });
    expect(watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_1", "task_2"] }),
    );
  });

  it("rejects task_ids that is empty, non-array, or all non-strings", async () => {
    const { services, watchService } = buildServices();
    const t = tool("watch_tasks", ctx, services);

    for (const task_ids of [[], "task_1", undefined, [1, 2]]) {
      const res = await t.handler({ task_ids } as Record<string, unknown>);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("watch_validation");
      expect(res.content.message).toBe(
        "task_ids must be a non-empty array of strings",
      );
    }
    // Never reached the service — the guard is upstream of it.
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("rejects the call when there is no session context", async () => {
    const { services, watchService } = buildServices();
    const res = await tool("watch_tasks", { agentId: "agent_a" }, services).handler({
      task_ids: ["task_1"],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(watchService.watchTasks).not.toHaveBeenCalled();
  });
});

// ── unwatch ──────────────────────────────────────────────────────────────

describe("unwatch", () => {
  it("cancels the watch and reports ok", async () => {
    const { services, watchService } = buildServices();
    const res = await tool("unwatch", ctx, services).handler({
      watch_id: "twatch_1",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "twatch_1",
    });
  });

  it("does not need a session context — only the caller agent", async () => {
    const { services, watchService } = buildServices();
    const res = await tool("unwatch", { agentId: "agent_a" }, services).handler({
      watch_id: "twatch_1",
    });
    expect(res.content).toEqual({ ok: true });
    expect(watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "twatch_1",
    });
  });

  it("rejects a missing or non-string watch_id", async () => {
    const { services, watchService } = buildServices();
    const t = tool("unwatch", ctx, services);

    for (const watch_id of [undefined, "", 7]) {
      const res = await t.handler({ watch_id } as Record<string, unknown>);
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({
        error: "watch_validation",
        message: "watch_id must be a non-empty string",
      });
    }
    expect(watchService.unwatch).not.toHaveBeenCalled();
  });
});

// ── error mapping ────────────────────────────────────────────────────────

describe("service error mapping", () => {
  // Each WatchService error class gets its own stable code so the calling
  // agent can branch; anything else degrades to the generic watch_error.
  const cases: ReadonlyArray<[string, unknown, string, string]> = [
    ["WatchAuthError", new WatchAuthError("not yours"), "watch_auth", "not yours"],
    [
      "WatchValidationError",
      new WatchValidationError("bad mode"),
      "watch_validation",
      "bad mode",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("twatch_x"),
      "watch_not_found",
      "task_watch twatch_x not found",
    ],
    ["a plain Error", new Error("pg down"), "watch_error", "pg down"],
    ["a non-Error throw", "kaboom", "watch_error", "kaboom"],
  ];

  for (const [label, thrown, code, message] of cases) {
    it(`maps ${label} on watch_tasks`, async () => {
      const { services } = buildServices({
        watchTasks: vi.fn(async () => {
          throw thrown;
        }),
      } as Partial<WatchService>);
      const res = await tool("watch_tasks", ctx, services).handler({
        task_ids: ["task_1"],
      });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message });
    });

    it(`maps ${label} on unwatch`, async () => {
      const { services } = buildServices({
        unwatch: vi.fn(async () => {
          throw thrown;
        }),
      } as Partial<WatchService>);
      const res = await tool("unwatch", ctx, services).handler({
        watch_id: "twatch_1",
      });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({ error: code, message });
    });
  }
});
