/**
 * use_repo handler tests.
 *
 * The tool's job is ordering + validation: reject bad goals/urls before
 * touching the DB, create the container task, dispatch the session under
 * a pre-minted id, then insert the repo_run that FK-references it. Each
 * of those steps has a failure envelope the agent branches on, and the
 * *order* is load-bearing (repo_run.session_id has an FK to session.id),
 * so the happy path asserts the sequence as well as the result.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";
import type { AgentTool } from "./types.js";

interface Harness {
  tool: AgentTool;
  /** Ordered log of the DB/service calls the handler made. */
  order: string[];
  taskCreates: Array<Record<string, unknown>>;
  dispatches: Array<Record<string, unknown>>;
  repoRunCreates: Array<Record<string, unknown>>;
}

function harness(
  overrides: {
    agent?: { id: string } | null;
    dispatch?: () => Promise<unknown>;
    repoRunCreate?: () => Promise<unknown>;
  } = {},
): Harness {
  const order: string[] = [];
  const taskCreates: Array<Record<string, unknown>> = [];
  const dispatches: Array<Record<string, unknown>> = [];
  const repoRunCreates: Array<Record<string, unknown>> = [];

  const agent =
    overrides.agent === undefined ? { id: "agent_a" } : overrides.agent;

  const services = {
    agentRepo: {
      findById: vi.fn(async () => {
        order.push("agent.findById");
        return agent;
      }),
    } as unknown as AgentRepository,
    taskRepo: {
      create: vi.fn(async (row: Record<string, unknown>) => {
        order.push("task.create");
        taskCreates.push(row);
        return row as unknown as Task;
      }),
    } as unknown as TaskRepository,
    repoRunRepo: {
      create: vi.fn(async (row: Record<string, unknown>) => {
        order.push("repoRun.create");
        repoRunCreates.push(row);
        if (overrides.repoRunCreate) return overrides.repoRunCreate();
        return row;
      }),
    } as unknown as RepoRunRepository,
    dispatchService: {
      dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
        order.push("dispatch");
        dispatches.push(input);
        if (overrides.dispatch) return overrides.dispatch();
        return { session: { id: input.sessionIdOverride }, runtime_id: null };
      }),
    } as unknown as DispatchService,
  } satisfies UseRepoServices;

  return {
    tool: createUseRepoTool({ agentId: "agent_a" }, services),
    order,
    taskCreates,
    dispatches,
    repoRunCreates,
  };
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool descriptor", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { tool } = harness();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo happy path", () => {
  it("creates the task, dispatches, then inserts the repo_run — in that order", async () => {
    const h = harness();

    const result = await h.tool.handler(OK_INPUT);

    expect(h.order).toEqual([
      "agent.findById",
      "task.create",
      "dispatch",
      "repoRun.create",
    ]);
    expect(result.isError).toBeFalsy();
  });

  it("dispatches under the same pre-minted session id the repo_run references", async () => {
    const h = harness();

    const result = await h.tool.handler(OK_INPUT);

    const sessionId = h.dispatches[0]?.sessionIdOverride;
    expect(typeof sessionId).toBe("string");
    expect(h.repoRunCreates[0]?.session_id).toBe(sessionId);
    expect(result.content.session_id).toBe(sessionId);
  });

  it("dispatches a run_repo session carrying the goal as the intent", async () => {
    const h = harness();

    await h.tool.handler(OK_INPUT);

    expect(h.dispatches[0]).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: OK_INPUT.goal,
      reason: { kind: "fresh" },
    });
  });

  it("pins the container task to the resolved agent on both sides", async () => {
    const h = harness();

    await h.tool.handler(OK_INPUT);

    expect(h.taskCreates[0]).toMatchObject({
      title: OK_INPUT.goal,
      description: OK_INPUT.goal,
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });
  });

  it("seeds the repo_run pending, tied to the container task and repo url", async () => {
    const h = harness();

    await h.tool.handler(OK_INPUT);

    expect(h.repoRunCreates[0]).toMatchObject({
      task_id: h.taskCreates[0]?.id,
      agent_id: "agent_a",
      goal: OK_INPUT.goal,
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });
  });

  it("returns the ids, status and a watch url pointing at the repo_run", async () => {
    const h = harness();

    const result = await h.tool.handler(OK_INPUT);

    const repoRunId = h.repoRunCreates[0]?.id;
    expect(result.content).toMatchObject({
      repo_run_id: repoRunId,
      task_id: h.taskCreates[0]?.id,
      status: "pending",
      watch_url: `/capabilities/runs/${repoRunId}`,
    });
  });

  it("trims whitespace off goal and repo_url", async () => {
    const h = harness();

    await h.tool.handler({
      goal: "  clean me  ",
      repo_url: "  https://github.com/a/b  ",
    });

    expect(h.repoRunCreates[0]).toMatchObject({
      goal: "clean me",
      repo_url: "https://github.com/a/b",
    });
  });

  it("truncates the container task title at 80 chars and collapses whitespace", async () => {
    const h = harness();

    await h.tool.handler({
      ...OK_INPUT,
      goal: "a".repeat(50) + "\n\n  " + "b".repeat(50),
    });

    // 77 chars of goal + the ellipsis.
    const title = h.taskCreates[0]?.title as string;
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("\n");
    // The untruncated description keeps the raw goal.
    expect(h.taskCreates[0]?.description).toContain("\n\n");
  });

  it("echoes input_url / input_filename back, trimmed, and omits them when absent", async () => {
    const withInput = harness();
    const withoutInput = harness();

    const a = await withInput.tool.handler({
      ...OK_INPUT,
      input_url: "  https://example.com/doc.pdf  ",
      input_filename: "  doc.pdf  ",
    });
    const b = await withoutInput.tool.handler(OK_INPUT);

    expect(a.content).toMatchObject({
      input_url: "https://example.com/doc.pdf",
      input_filename: "doc.pdf",
    });
    expect(b.content.input_url).toBeUndefined();
    expect(b.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limits parsing", () => {
  it("passes sane limits through untouched", async () => {
    const h = harness();

    const result = await h.tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const h = harness();

    const result = await h.tool.handler({
      ...OK_INPUT,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors the integer limits but leaves wall clock fractional", async () => {
    const h = harness();

    const result = await h.tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 2.5, max_install_attempts: 3.9, disk_mb: 100.7 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 2.5,
      max_install_attempts: 3,
      disk_mb: 100,
    });
  });

  it("drops non-positive and non-numeric limits rather than failing the call", async () => {
    const h = harness();

    const result = await h.tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: "big" },
    });

    expect(result.content.limits).toEqual({});
  });

  it("treats a missing or non-object limits as empty", async () => {
    const h = harness();

    const a = await h.tool.handler(OK_INPUT);
    const b = await h.tool.handler({ ...OK_INPUT, limits: "none" });
    const c = await h.tool.handler({ ...OK_INPUT, limits: null });

    expect(a.content.limits).toEqual({});
    expect(b.content.limits).toEqual({});
    expect(c.content.limits).toEqual({});
  });
});

describe("use_repo rejections", () => {
  it("rejects a blank or non-string goal before any DB call", async () => {
    const h = harness();

    for (const goal of ["", "   ", 42, undefined]) {
      const result = await h.tool.handler({ ...OK_INPUT, goal });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(h.order).toEqual([]);
  });

  it("rejects non-GitHub, non-https and malformed repo urls", async () => {
    const h = harness();

    for (const repo_url of [
      "",
      "http://github.com/a/b", // not https
      "https://gitlab.com/a/b", // not github
      "https://notgithub.com/a/b",
      "https://github.com.evil.test/a/b",
      "not a url at all",
      7,
    ]) {
      const result = await h.tool.handler({ ...OK_INPUT, repo_url });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    }
    expect(h.order).toEqual([]);
  });

  it("accepts a github subdomain url", async () => {
    const h = harness();

    const result = await h.tool.handler({
      ...OK_INPUT,
      repo_url: "https://www.github.com/a/b",
    });

    expect(result.isError).toBeFalsy();
  });

  it("reports agent_not_found and creates nothing when the caller is unknown", async () => {
    const h = harness({ agent: null });

    const result = await h.tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.order).toEqual(["agent.findById"]);
  });

  it("reports dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const h = harness({
      dispatch: async () => {
        throw new Error("no runtime online");
      },
    });

    const result = await h.tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(h.repoRunCreates).toHaveLength(0);
  });

  it("reports repo_run_create_failed when the insert throws after dispatch", async () => {
    const h = harness({
      repoRunCreate: async () => {
        throw new Error("duplicate key");
      },
    });

    const result = await h.tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    expect(h.dispatches).toHaveLength(1);
  });

  it("stringifies non-Error throws on both failure paths", async () => {
    const dispatchBoom = harness({
      dispatch: async () => {
        throw "dispatch string boom";
      },
    });
    const insertBoom = harness({
      repoRunCreate: async () => {
        throw "insert string boom";
      },
    });

    expect((await dispatchBoom.tool.handler(OK_INPUT)).content).toMatchObject({
      error: "dispatch_failed",
      message: "dispatch string boom",
    });
    expect((await insertBoom.tool.handler(OK_INPUT)).content).toMatchObject({
      error: "repo_run_create_failed",
      message: "insert string boom",
    });
  });
});
