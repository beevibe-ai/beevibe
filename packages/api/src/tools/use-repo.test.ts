/**
 * use_repo handler tests.
 *
 * The tool is the Capability Network's write path: it mints a container
 * task, dispatches a `run_repo` session under a pre-minted session id,
 * then inserts the repo_run row that the daemon's dispatch payload
 * composer looks up by that session id. The ordering and the two
 * partial-failure envelopes are the whole contract — everything the
 * daemon sees depends on them, and neither is reachable from the e2e
 * sandbox script, so they're pinned here with fakes.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRun,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const AGENT: Agent = {
  id: "agent_caller",
  name: "Caller",
  owner_id: "user_1",
  hierarchy_level: "ic",
  runtime_config: {} as Agent["runtime_config"],
  created_at: new Date("2025-01-01T00:00:00Z"),
  updated_at: new Date("2025-01-01T00:00:00Z"),
};

interface Harness {
  services: UseRepoServices;
  dispatchCalls: Array<Record<string, unknown>>;
  taskCreateCalls: Array<Record<string, unknown>>;
  repoRunCreateCalls: Array<Record<string, unknown>>;
  /** Records the order tool-visible writes happened in. */
  order: string[];
}

function harness(
  overrides: {
    agent?: Agent | undefined;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const dispatchCalls: Array<Record<string, unknown>> = [];
  const taskCreateCalls: Array<Record<string, unknown>> = [];
  const repoRunCreateCalls: Array<Record<string, unknown>> = [];
  const order: string[] = [];

  const agent = "agent" in overrides ? overrides.agent : AGENT;

  const agentRepo = {
    findById: vi.fn(async () => agent),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("task.create");
      taskCreateCalls.push(row);
      return { ...row, status: "pending" } as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("repoRun.create");
      repoRunCreateCalls.push(row);
      if ("repoRunThrows" in overrides) throw overrides.repoRunThrows;
      return row as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      order.push("dispatch");
      dispatchCalls.push(input);
      if ("dispatchThrows" in overrides) throw overrides.dispatchThrows;
      return { sessionId: input.sessionIdOverride } as never;
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    dispatchCalls,
    taskCreateCalls,
    repoRunCreateCalls,
    order,
  };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: "agent_caller" }, h.services);
}

describe("use_repo — input validation", () => {
  it.each([
    ["missing goal", { repo_url: "https://github.com/o/r" }],
    ["blank goal", { goal: "   ", repo_url: "https://github.com/o/r" }],
    ["non-string goal", { goal: 42, repo_url: "https://github.com/o/r" }],
  ])("rejects %s before touching any repository", async (_label, input) => {
    const h = harness();
    const result = await tool(h).handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.services.agentRepo.findById).not.toHaveBeenCalled();
    expect(h.order).toEqual([]);
  });

  it.each([
    ["missing repo_url", undefined],
    ["blank repo_url", "   "],
    ["a non-GitHub host", "https://gitlab.com/o/r"],
    // The hostname anchor is `(^|\.)github\.com$` — a lookalike domain
    // that merely *contains* github.com must not slip through.
    ["a lookalike host", "https://github.com.evil.test/o/r"],
    ["plain http", "http://github.com/o/r"],
    ["a git+ssh remote", "git@github.com:o/r.git"],
    ["an unparseable url", "not a url at all"],
  ])("rejects %s", async (_label, repoUrl) => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "extract the tables",
      ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.order).toEqual([]);
  });

  it("accepts a github subdomain and trims surrounding whitespace", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "  extract the tables  ",
      repo_url: "  https://www.github.com/o/r  ",
    });

    expect(result.isError).toBeFalsy();
    expect(h.repoRunCreateCalls[0]).toMatchObject({
      goal: "extract the tables",
      repo_url: "https://www.github.com/o/r",
    });
  });

  it("returns agent_not_found when the bv_a_ token resolves to nothing", async () => {
    const h = harness({ agent: undefined });
    const result = await tool(h).handler({
      goal: "extract the tables",
      repo_url: "https://github.com/o/r",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.order).toEqual([]);
  });
});

describe("use_repo — happy path", () => {
  it("dispatches the session BEFORE inserting repo_run, under one session id", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "Extract the tables from this PDF as JSON",
      repo_url: "https://github.com/jsvine/pdfplumber",
    });

    // repo_run.session_id has an FK to session.id, so the dispatch that
    // creates the session row has to land first.
    expect(h.order).toEqual(["task.create", "dispatch", "repoRun.create"]);

    const sessionIdValue = h.dispatchCalls[0]?.sessionIdOverride;
    expect(sessionIdValue).toEqual(expect.any(String));
    expect(h.repoRunCreateCalls[0]).toMatchObject({
      session_id: sessionIdValue,
      status: "pending",
    });
    expect(result.content).toMatchObject({
      session_id: sessionIdValue,
      status: "pending",
    });
  });

  it("pins the container task to the resolved agent as both creator and assignee", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "Extract the tables",
      repo_url: "https://github.com/o/r",
    });

    expect(h.taskCreateCalls[0]).toMatchObject({
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
      priority: "medium",
      description: "Extract the tables",
    });
  });

  it("dispatches as a run_repo fresh session with the goal as intent", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "Extract the tables",
      repo_url: "https://github.com/o/r",
    });

    expect(h.dispatchCalls[0]).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: "Extract the tables",
      reason: { kind: "fresh" },
    });
    expect(h.dispatchCalls[0]?.task).toMatchObject({
      id: h.taskCreateCalls[0]?.id,
    });
  });

  it("returns the ids, the watch url and the polling hint", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "Extract the tables",
      repo_url: "https://github.com/o/r",
    });

    const repoRunId = h.repoRunCreateCalls[0]?.id as string;
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      repo_run_id: repoRunId,
      task_id: h.taskCreateCalls[0]?.id,
      status: "pending",
      watch_url: `/capabilities/runs/${repoRunId}`,
    });
    expect(String(result.content.note)).toContain("repo_run.status");
  });

  it("passes trimmed input_url + input_filename back to the caller", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "Extract the tables",
      repo_url: "https://github.com/o/r",
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.test/a.pdf",
      input_filename: "a.pdf",
    });
  });
});

describe("use_repo — container task title", () => {
  it("collapses runs of whitespace so the inbox row is scannable", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "  extract\n\ttables   from   the PDF  ",
      repo_url: "https://github.com/o/r",
    });

    expect(h.taskCreateCalls[0]?.title).toBe("extract tables from the PDF");
  });

  it("truncates past 80 chars with an ellipsis but keeps the goal intact", async () => {
    const h = harness();
    const goal = "x".repeat(200);
    await tool(h).handler({ goal, repo_url: "https://github.com/o/r" });

    const title = h.taskCreateCalls[0]?.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(h.taskCreateCalls[0]?.description).toBe(goal);
  });

  it("leaves an exactly-80-char title alone", async () => {
    const h = harness();
    const goal = "y".repeat(80);
    await tool(h).handler({ goal, repo_url: "https://github.com/o/r" });

    expect(h.taskCreateCalls[0]?.title).toBe(goal);
  });
});

describe("use_repo — limits parsing", () => {
  async function limitsOf(raw: unknown): Promise<Record<string, unknown>> {
    const h = harness();
    const result = await tool(h).handler({
      goal: "g",
      repo_url: "https://github.com/o/r",
      ...(raw === undefined ? {} : { limits: raw }),
    });
    return result.content.limits as Record<string, unknown>;
  }

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a string", "20"],
    ["a number", 20],
  ])("defaults to {} when limits is %s", async (_label, raw) => {
    expect(await limitsOf(raw)).toEqual({});
  });

  it("passes through in-range values untouched", async () => {
    expect(
      await limitsOf({
        wall_clock_minutes: 30,
        max_install_attempts: 3,
        disk_mb: 4096,
      }),
    ).toEqual({
      wall_clock_minutes: 30,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps each field to its ceiling", async () => {
    expect(
      await limitsOf({
        wall_clock_minutes: 999,
        max_install_attempts: 50,
        disk_mb: 1_000_000,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors the integer-only fields but not the wall clock", async () => {
    expect(
      await limitsOf({
        wall_clock_minutes: 12.5,
        max_install_attempts: 2.9,
        disk_mb: 512.7,
      }),
    ).toEqual({
      wall_clock_minutes: 12.5,
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a numeric string", "10"],
  ])("drops %s values rather than clamping them", async (_label, value) => {
    expect(
      await limitsOf({
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      }),
    ).toEqual({});
  });
});

describe("use_repo — partial failure", () => {
  it("returns dispatch_failed and never inserts an orphan repo_run", async () => {
    const h = harness({ dispatchThrows: new Error("no runtime online") });
    const result = await tool(h).handler({
      goal: "g",
      repo_url: "https://github.com/o/r",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(h.order).toEqual(["task.create", "dispatch"]);
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "boom" });
    const result = await tool(h).handler({
      goal: "g",
      repo_url: "https://github.com/o/r",
    });

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("surfaces repo_run_create_failed rather than silently leaving the agent to wait", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const result = await tool(h).handler({
      goal: "g",
      repo_url: "https://github.com/o/r",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });
});

describe("use_repo — tool surface", () => {
  it("declares goal + repo_url as the only required inputs", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    expect(t.schema.additionalProperties).toBe(false);
  });
});
