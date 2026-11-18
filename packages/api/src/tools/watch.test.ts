/**
 * watch_tasks + unwatch tools — unit tests with vitest fakes (no DB).
 *
 * Both tools are thin adapters over WatchService: the service owns the
 * auth check, the insert, the already-terminal race and the unwatch
 * state machine. What's tested here is the adapter's own job — input
 * coercion (task_ids filtering, mode defaulting, reason trimming), the
 * session-context guard, and the mapping of each WatchService error
 * class onto its stable tool-error code.
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

// ── Fakes ────────────────────────────────────────────────────────────────

function buildServices(overrides: Partial<WatchService> = {}) {
  return {
    watchService: {
      watchTasks: vi.fn(async () => ({
        watchId: "tw_1",
        firedImmediately: false,
      })),
      unwatch: vi.fn(async () => undefined),
      ...overrides,
    } as unknown as WatchService,
  };
}

const CTX: WatchToolContext = { agentId: "agent_a", sessionId: "sess_1" };

function tools(
  ctx: WatchToolContext = CTX,
  services = buildServices(),
): { tools: AgentTool[]; services: ReturnType<typeof buildServices> } {
  return { tools: buildWatchTools(ctx, services), services };
}

function findTool(all: AgentTool[], name: string): AgentTool {
  const t = all.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} missing from set`);
  return t;
}

function call(
  all: AgentTool[],
  name: string,
  input: Record<string, unknown> = {},
): Promise<AgentToolResult> {
  return findTool(all, name).handler(input);
}

// ── Surface ──────────────────────────────────────────────────────────────

describe("buildWatchTools", () => {
  it("returns watch_tasks and unwatch, in that order", () => {
    expect(tools().tools.map((t) => t.name)).toEqual([
      "watch_tasks",
      "unwatch",
    ]);
  });

  it("advertises both watch modes on watch_tasks and requires task_ids", () => {
    const t = findTool(tools().tools, "watch_tasks");
    const props = t.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.mode?.enum).toEqual(["all", "any"]);
    expect(t.schema.required).toEqual(["task_ids"]);
  });
});

// ── watch_tasks: input coercion ──────────────────────────────────────────

describe("watch_tasks — task_ids", () => {
  it.each([
    ["absent", {}],
    ["an empty array", { task_ids: [] }],
    ["not an array", { task_ids: "task_1" }],
    // A caller that sends only non-strings has effectively sent nothing;
    // the filter empties the array and the guard has to catch it rather
    // than passing [] down to the service.
    ["an array of non-strings", { task_ids: [1, null, {}] }],
  ])("rejects task_ids that is %s", async (_label, input) => {
    const { tools: all, services } = tools();
    const res = await call(all, "watch_tasks", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("watch_validation");
    expect(services.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("drops non-string entries but keeps the valid ones", async () => {
    const { tools: all, services } = tools();
    const res = await call(all, "watch_tasks", {
      task_ids: ["task_1", 42, null, "task_2", undefined],
    });
    expect(res.isError).toBeUndefined();
    expect(services.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: ["task_1", "task_2"] }),
    );
  });
});

describe("watch_tasks — mode", () => {
  it("defaults to 'all' when omitted", async () => {
    const { tools: all, services } = tools();
    await call(all, "watch_tasks", { task_ids: ["task_1"] });
    expect(services.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "all" }),
    );
  });

  it.each(["all", "any"] as const)("passes through mode=%s", async (mode) => {
    const { tools: all, services } = tools();
    await call(all, "watch_tasks", { task_ids: ["task_1"], mode });
    expect(services.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ mode }),
    );
  });

  it.each([
    ["an unknown string", "first"],
    ["a non-string", 1],
  ])(
    "falls back to 'all' rather than erroring when mode is %s",
    async (_label, mode) => {
      const { tools: all, services } = tools();
      await call(all, "watch_tasks", { task_ids: ["task_1"], mode });
      expect(services.watchService.watchTasks).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "all" }),
      );
    },
  );
});

describe("watch_tasks — reason", () => {
  it("trims the reason before handing it to the service", async () => {
    const { tools: all, services } = tools();
    await call(all, "watch_tasks", {
      task_ids: ["task_1"],
      reason: "  review the PR  ",
    });
    expect(services.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "review the PR" }),
    );
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["empty", ""],
    ["a non-string", 5],
  ])("sends no reason when it is %s", async (_label, reason) => {
    const { tools: all, services } = tools();
    await call(all, "watch_tasks", { task_ids: ["task_1"], reason });
    expect(services.watchService.watchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });
});

describe("watch_tasks — session context", () => {
  it("refuses without a session id: there'd be no waiter to wake", async () => {
    const { tools: all, services } = tools({ agentId: "agent_a" });
    const res = await call(all, "watch_tasks", { task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "watch_validation",
      message: "watch_tasks must be called inside a session context",
    });
    expect(services.watchService.watchTasks).not.toHaveBeenCalled();
  });

  it("identifies the waiter by caller agent + session", async () => {
    const { tools: all, services } = tools();
    await call(all, "watch_tasks", { task_ids: ["task_1"] });
    expect(services.watchService.watchTasks).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      callerSessionId: "sess_1",
      taskIds: ["task_1"],
      mode: "all",
      reason: undefined,
    });
  });
});

describe("watch_tasks — result projection", () => {
  it("returns the watch id and fired_immediately=false for a pending watch", async () => {
    const { tools: all } = tools();
    const res = await call(all, "watch_tasks", { task_ids: ["task_1"] });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({
      watch_id: "tw_1",
      fired_immediately: false,
    });
  });

  it("surfaces fired_immediately=true when the condition was already met", async () => {
    const { tools: all } = tools(
      CTX,
      buildServices({
        watchTasks: vi.fn(async () => ({
          watchId: "tw_9",
          firedImmediately: true,
        })),
      }),
    );
    const res = await call(all, "watch_tasks", { task_ids: ["task_1"] });
    expect(res.content).toEqual({ watch_id: "tw_9", fired_immediately: true });
  });
});

// ── unwatch ──────────────────────────────────────────────────────────────

describe("unwatch", () => {
  it("returns ok and forwards the caller + watch id", async () => {
    const { tools: all, services } = tools();
    const res = await call(all, "unwatch", { watch_id: "tw_1" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual({ ok: true });
    expect(services.watchService.unwatch).toHaveBeenCalledWith({
      callerAgentId: "agent_a",
      watchId: "tw_1",
    });
  });

  it.each([
    ["absent", {}],
    ["empty", { watch_id: "" }],
    ["a non-string", { watch_id: 1 }],
  ])("rejects a watch_id that is %s", async (_label, input) => {
    const { tools: all, services } = tools();
    const res = await call(all, "unwatch", input);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "watch_validation",
      message: "watch_id must be a non-empty string",
    });
    expect(services.watchService.unwatch).not.toHaveBeenCalled();
  });

  it("works without a session id — unwatching needs no waiter", async () => {
    const { tools: all } = tools({ agentId: "agent_a" });
    const res = await call(all, "unwatch", { watch_id: "tw_1" });
    expect(res.content).toEqual({ ok: true });
  });
});

// ── Error mapping (shared by both tools) ─────────────────────────────────

describe("watch tools — error mapping", () => {
  // Each WatchService error class has to land on its own stable code:
  // agents branch on these strings, so collapsing any two would be a
  // silent wire-contract change.
  it.each([
    ["WatchAuthError", new WatchAuthError("not your task"), "watch_auth"],
    [
      "WatchValidationError",
      new WatchValidationError("bad mode"),
      "watch_validation",
    ],
    [
      "WatchNotFoundError",
      new WatchNotFoundError("tw_404"),
      "watch_not_found",
    ],
    ["a plain Error", new Error("pg down"), "watch_error"],
  ])("maps %s to %s on watch_tasks", async (_label, err, code) => {
    const { tools: all } = tools(
      CTX,
      buildServices({
        watchTasks: vi.fn(async () => {
          throw err;
        }),
      }),
    );
    const res = await call(all, "watch_tasks", { task_ids: ["task_1"] });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe((err as Error).message);
  });

  it.each([
    ["WatchAuthError", new WatchAuthError("not yours"), "watch_auth"],
    ["WatchNotFoundError", new WatchNotFoundError("tw_404"), "watch_not_found"],
    ["a plain Error", new Error("pg down"), "watch_error"],
  ])("maps %s to %s on unwatch", async (_label, err, code) => {
    const { tools: all } = tools(
      CTX,
      buildServices({
        unwatch: vi.fn(async () => {
          throw err;
        }),
      }),
    );
    const res = await call(all, "unwatch", { watch_id: "tw_1" });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe(code);
  });

  it("stringifies a non-Error throw under watch_error", async () => {
    const { tools: all } = tools(
      CTX,
      buildServices({
        watchTasks: vi.fn(async () => {
          throw "boom";
        }),
      }),
    );
    const res = await call(all, "watch_tasks", { task_ids: ["task_1"] });
    expect(res.content).toMatchObject({
      error: "watch_error",
      message: "boom",
    });
  });
});
