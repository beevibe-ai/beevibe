/**
 * use_repo MCP tool — the Capability Network's verb (#149).
 *
 * The orchestration itself runs on the daemon; what this module owns is
 * the front door: input validation, the limits clamp, the container
 * task it mints, and the two-step write whose ORDER is a documented FK
 * constraint — `repo_run.session_id` references `session.id`, so the
 * dispatch (which inserts the session) must land before the repo_run
 * insert. These tests pin that ordering and both of its failure
 * envelopes, since getting it wrong produces an orphan session that
 * only self-recovers as a late "failed" the agent waits on.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";

import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const ctx = { agentId: "agent_a" };

interface Harness {
  tool: ReturnType<typeof createUseRepoTool>;
  calls: string[];
  taskCreates: Array<Record<string, unknown>>;
  dispatches: Array<Record<string, unknown>>;
  repoRunCreates: Array<Record<string, unknown>>;
}

function harness(
  opts: {
    agent?: { id: string } | null;
    dispatchError?: unknown;
    repoRunError?: unknown;
  } = {},
): Harness {
  const calls: string[] = [];
  const taskCreates: Array<Record<string, unknown>> = [];
  const dispatches: Array<Record<string, unknown>> = [];
  const repoRunCreates: Array<Record<string, unknown>> = [];
  const agent = opts.agent === undefined ? { id: "agent_a" } : opts.agent;

  const services = {
    agentRepo: {
      findById: vi.fn(async (id: string) => {
        calls.push(`agentRepo.findById:${id}`);
        return agent ?? undefined;
      }),
    },
    taskRepo: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        calls.push("taskRepo.create");
        taskCreates.push(input);
        return { ...input, status: "pending" } as unknown as Task;
      }),
    },
    repoRunRepo: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        calls.push("repoRunRepo.create");
        repoRunCreates.push(input);
        if (opts.repoRunError) throw opts.repoRunError;
        return input;
      }),
    },
    dispatchService: {
      dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
        calls.push("dispatchService.dispatchTask");
        dispatches.push(input);
        if (opts.dispatchError) throw opts.dispatchError;
        return { sessionId: input.sessionIdOverride };
      }),
    } as unknown as DispatchService,
  } as unknown as UseRepoServices;

  return {
    tool: createUseRepoTool(ctx, services),
    calls,
    taskCreates,
    dispatches,
    repoRunCreates,
  };
}

const GOOD = { goal: "Extract the tables from this PDF", repo_url: "https://github.com/o/r" };

describe("use_repo tool shape", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { tool } = harness();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });

  it("documents itself as the sandboxed alternative to a host install", () => {
    const { tool } = harness();
    expect(tool.description).toContain("sandbox");
    expect(tool.description).toContain("find_repo");
  });
});

describe("goal validation", () => {
  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["a non-string", 42],
  ])("rejects a goal that is %s, before any write", async (_label, goal) => {
    const h = harness();
    const input: Record<string, unknown> = { repo_url: GOOD.repo_url };
    if (goal !== undefined) input.goal = goal;

    const result = await h.tool.handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.calls).toEqual([]);
  });
});

describe("repo_url validation", () => {
  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["a non-URL string", "not a url"],
    ["plain http", "http://github.com/o/r"],
    ["an ssh git URL", "git@github.com:o/r.git"],
    ["a non-GitHub host", "https://gitlab.com/o/r"],
    ["a lookalike host", "https://notgithub.com/o/r"],
    ["a GitHub-prefixed host", "https://github.com.evil.example/o/r"],
  ])("rejects %s, before any write", async (_label, repoUrl) => {
    const h = harness();
    const input: Record<string, unknown> = { goal: GOOD.goal };
    if (repoUrl !== undefined) input.repo_url = repoUrl;

    const result = await h.tool.handler(input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.calls).toEqual([]);
  });

  it.each([
    "https://github.com/o/r",
    "https://www.github.com/o/r",
    "https://GitHub.com/o/r",
    "https://github.com/o/r/tree/main/sub",
  ])("accepts %s", async (repoUrl) => {
    const h = harness();

    const result = await h.tool.handler({ goal: GOOD.goal, repo_url: repoUrl });

    expect(result.isError).toBeFalsy();
  });

  it("trims surrounding whitespace before validating", async () => {
    const h = harness();

    const result = await h.tool.handler({
      goal: GOOD.goal,
      repo_url: "  https://github.com/o/r  ",
    });

    expect(result.isError).toBeFalsy();
    expect(h.repoRunCreates[0]?.repo_url).toBe("https://github.com/o/r");
  });
});

describe("caller resolution", () => {
  it("looks the calling agent up and refuses when it is gone", async () => {
    const h = harness({ agent: null });

    const result = await h.tool.handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // No task, no session, no repo_run.
    expect(h.calls).toEqual(["agentRepo.findById:agent_a"]);
  });
});

describe("container task", () => {
  it("pins creator and assignee to the resolved agent and keeps the full goal as the description", async () => {
    const h = harness();

    await h.tool.handler(GOOD);

    expect(h.taskCreates[0]).toMatchObject({
      title: "Extract the tables from this PDF",
      description: "Extract the tables from this PDF",
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });
    expect(String(h.taskCreates[0]?.id)).toMatch(/^task_/);
  });

  it("collapses internal whitespace in the title but not the description", async () => {
    const h = harness();

    await h.tool.handler({ ...GOOD, goal: "Extract\n\n  the   tables" });

    expect(h.taskCreates[0]?.title).toBe("Extract the tables");
    expect(h.taskCreates[0]?.description).toBe("Extract\n\n  the   tables");
  });

  it("leaves an 80-char title untouched", async () => {
    const h = harness();
    const goal = "g".repeat(80);

    await h.tool.handler({ ...GOOD, goal });

    expect(h.taskCreates[0]?.title).toBe(goal);
    expect(String(h.taskCreates[0]?.title)).toHaveLength(80);
  });

  // Over 80 the title becomes 77 chars + an ellipsis, so the inbox row
  // stays scannable; the description keeps the whole goal.
  it("truncates a longer title to 77 chars plus an ellipsis", async () => {
    const h = harness();
    const goal = "g".repeat(200);

    await h.tool.handler({ ...GOOD, goal });

    expect(h.taskCreates[0]?.title).toBe("g".repeat(77) + "…");
    expect(String(h.taskCreates[0]?.title)).toHaveLength(78);
    expect(h.taskCreates[0]?.description).toBe(goal);
  });

  it("uses the trimmed goal, so padding does not count toward the limit", async () => {
    const h = harness();

    await h.tool.handler({ ...GOOD, goal: `   ${"g".repeat(80)}   ` });

    expect(h.taskCreates[0]?.title).toBe("g".repeat(80));
  });
});

describe("dispatch", () => {
  it("dispatches a run_repo session for the container task under a pre-minted id", async () => {
    const h = harness();

    const result = await h.tool.handler(GOOD);

    expect(h.dispatches).toHaveLength(1);
    const dispatch = h.dispatches[0]!;
    expect(dispatch).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
    });
    expect((dispatch.task as Task).id).toBe(h.taskCreates[0]?.id);
    // The override is what ties the session row to the repo_run below.
    expect(dispatch.sessionIdOverride).toBe(result.content.session_id);
  });

  // The FK on repo_run.session_id means the session must exist first.
  it("dispatches BEFORE inserting the repo_run", async () => {
    const h = harness();

    await h.tool.handler(GOOD);

    expect(h.calls).toEqual([
      "agentRepo.findById:agent_a",
      "taskRepo.create",
      "dispatchService.dispatchTask",
      "repoRunRepo.create",
    ]);
  });

  it("reports dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const h = harness({ dispatchError: new Error("no runtime online") });

    const result = await h.tool.handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(h.repoRunCreates).toHaveLength(0);
  });

  it("stringifies a non-Error dispatch failure", async () => {
    const h = harness({ dispatchError: "runtime offline" });

    const result = await h.tool.handler(GOOD);

    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "runtime offline",
    });
  });
});

describe("repo_run row", () => {
  it("records the session, task, agent, goal and repo at pending", async () => {
    const h = harness();

    const result = await h.tool.handler(GOOD);

    expect(h.repoRunCreates[0]).toEqual({
      id: result.content.repo_run_id,
      session_id: result.content.session_id,
      task_id: h.taskCreates[0]?.id,
      agent_id: "agent_a",
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  // The session row already landed, so this leaves an orphan session
  // that self-recovers as a failed session — the agent has to be told,
  // or it waits on a run that will never report.
  it("reports repo_run_create_failed rather than a silent wait", async () => {
    const h = harness({ repoRunError: new Error("duplicate key value") });

    const result = await h.tool.handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key value",
    });
  });

  it("stringifies a non-Error repo_run failure", async () => {
    const h = harness({ repoRunError: { code: "23505" } });

    const result = await h.tool.handler(GOOD);

    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof result.content.message).toBe("string");
  });
});

describe("limits parsing", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const h = harness();
    const result = await h.tool.handler({ ...GOOD, limits });
    return result.content.limits as Record<string, unknown>;
  }

  it("passes sane values through", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 2, disk_mb: 2048 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 2, disk_mb: 2048 });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("keeps a value sitting exactly on its ceiling", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  // The two integer caps floor; wall clock stays fractional on purpose.
  it("floors the integer caps and leaves wall clock fractional", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 1.5, max_install_attempts: 2.9, disk_mb: 512.7 }),
    ).toEqual({ wall_clock_minutes: 1.5, max_install_attempts: 2, disk_mb: 512 });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a numeric string", "10"],
    ["null", null],
    ["NaN", Number.NaN],
  ])("drops a wall_clock_minutes that is %s", async (_label, value) => {
    expect(await limitsFor({ wall_clock_minutes: value })).toEqual({});
  });

  it("drops only the invalid members of a mixed object", async () => {
    expect(await limitsFor({ wall_clock_minutes: 5, max_install_attempts: 0, disk_mb: "big" })).toEqual(
      { wall_clock_minutes: 5 },
    );
  });

  it("floors a sub-1 integer cap away rather than clamping it up", async () => {
    // 0.5 is > 0 so it passes the guard, then floors to 0.
    expect(await limitsFor({ max_install_attempts: 0.5 })).toEqual({
      max_install_attempts: 0,
    });
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a string", "20m"],
    ["a number", 20],
  ])("yields an empty object when limits is %s", async (_label, value) => {
    expect(await limitsFor(value)).toEqual({});
  });

  // Arrays are objects, so they parse to {} rather than throwing.
  it("yields an empty object for an array", async () => {
    expect(await limitsFor([1, 2])).toEqual({});
  });
});

describe("optional sandbox input", () => {
  it("echoes a trimmed input_url and input_filename", async () => {
    const h = harness();

    const result = await h.tool.handler({
      ...GOOD,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("omits both when not supplied", async () => {
    const h = harness();

    const result = await h.tool.handler(GOOD);

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });

  it("ignores non-string values", async () => {
    const h = harness();

    const result = await h.tool.handler({ ...GOOD, input_url: 5, input_filename: false });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });

  // The sandbox input is not part of the repo_run row — it travels with
  // the dispatch payload — so the row must stay clean.
  it("does not leak onto the repo_run row", async () => {
    const h = harness();

    await h.tool.handler({ ...GOOD, input_url: "https://example.com/a.pdf" });

    expect(h.repoRunCreates[0]).not.toHaveProperty("input_url");
  });
});

describe("success envelope", () => {
  it("returns correlated ids, pending status, a watch url and a polling note", async () => {
    const h = harness();

    const result = await h.tool.handler(GOOD);

    expect(result.isError).toBeFalsy();
    const { repo_run_id, session_id, task_id, status, watch_url, note } = result.content;
    expect(String(repo_run_id)).toMatch(/^repo_/);
    expect(String(session_id)).toMatch(/^sess_/);
    expect(task_id).toBe(h.taskCreates[0]?.id);
    expect(status).toBe("pending");
    expect(watch_url).toBe(`/capabilities/runs/${String(repo_run_id)}`);
    expect(String(note)).toContain("poll");
  });

  it("mints fresh ids per call", async () => {
    const h = harness();

    const a = await h.tool.handler(GOOD);
    const b = await h.tool.handler(GOOD);

    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
    expect(a.content.task_id).not.toBe(b.content.task_id);
  });
});
