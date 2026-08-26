/**
 * use_repo tool tests.
 *
 * The handler's job is ordering + validation, not sandbox mechanics: mint
 * a container task, dispatch (which creates the session row), then insert
 * the repo_run that FKs to it. Every dependency is faked — the real ones
 * need Postgres and a live daemon.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

interface Recorder {
  services: UseRepoServices;
  taskCreates: Array<Record<string, unknown>>;
  dispatches: Array<Record<string, unknown>>;
  repoRunCreates: Array<Record<string, unknown>>;
}

function fakeServices(
  overrides: {
    agent?: { id: string } | null;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Recorder {
  const taskCreates: Array<Record<string, unknown>> = [];
  const dispatches: Array<Record<string, unknown>> = [];
  const repoRunCreates: Array<Record<string, unknown>> = [];
  const agent =
    overrides.agent === undefined ? { id: "agent_caller" } : overrides.agent;

  const services = {
    agentRepo: {
      findById: vi.fn(async () => agent),
    } as unknown as AgentRepository,
    taskRepo: {
      create: vi.fn(async (row: Record<string, unknown>) => {
        taskCreates.push(row);
        return row;
      }),
    } as unknown as TaskRepository,
    repoRunRepo: {
      create: vi.fn(async (row: Record<string, unknown>) => {
        if (overrides.repoRunThrows) throw overrides.repoRunThrows;
        repoRunCreates.push(row);
        return row;
      }),
    } as unknown as RepoRunRepository,
    dispatchService: {
      dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
        if (overrides.dispatchThrows) throw overrides.dispatchThrows;
        dispatches.push(input);
        return undefined;
      }),
    } as unknown as DispatchService,
  };

  return { services, taskCreates, dispatches, repoRunCreates };
}

function build(overrides?: Parameters<typeof fakeServices>[0]) {
  const rec = fakeServices(overrides);
  return { rec, tool: createUseRepoTool({ agentId: "agent_caller" }, rec.services) };
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool descriptor", () => {
  it("exposes the name and the two required schema fields", () => {
    const { tool } = build();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo validation", () => {
  it("rejects a missing goal before touching any service", async () => {
    const { rec, tool } = build();
    const result = await tool.handler({ repo_url: OK_INPUT.repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(rec.taskCreates).toHaveLength(0);
    expect(rec.dispatches).toHaveLength(0);
  });

  it("rejects a whitespace-only goal", async () => {
    const { tool } = build();
    const result = await tool.handler({ ...OK_INPUT, goal: "   " });
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it("rejects a non-string goal", async () => {
    const { tool } = build();
    const result = await tool.handler({ ...OK_INPUT, goal: 42 });
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["http, not https", "http://github.com/foo/bar"],
    ["a non-GitHub host", "https://gitlab.com/foo/bar"],
    ["a lookalike host", "https://notgithub.com/foo/bar"],
    ["a host that only ends in the string", "https://evilgithub.com/foo/bar"],
    ["unparseable", "not a url at all"],
    ["a non-string", 7],
  ])("rejects repo_url when it is %s", async (_label, repoUrl) => {
    const { rec, tool } = build();
    const result = await tool.handler({ ...OK_INPUT, repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(rec.dispatches).toHaveLength(0);
  });

  it.each([
    "https://github.com/jsvine/pdfplumber",
    "https://www.github.com/jsvine/pdfplumber",
    "https://GitHub.com/jsvine/pdfplumber",
  ])("accepts %s", async (repoUrl) => {
    const { tool } = build();
    const result = await tool.handler({ ...OK_INPUT, repo_url: repoUrl });
    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller is not in the agent repo", async () => {
    const { rec, tool } = build({ agent: null });
    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(rec.taskCreates).toHaveLength(0);
  });
});

describe("use_repo happy path", () => {
  it("mints a container task assigned to and created by the caller", async () => {
    const { rec, tool } = build();
    await tool.handler(OK_INPUT);

    expect(rec.taskCreates).toHaveLength(1);
    expect(rec.taskCreates[0]).toMatchObject({
      title: OK_INPUT.goal,
      description: OK_INPUT.goal,
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });
  });

  it("truncates a long goal to an 80-char task title but keeps the full description", async () => {
    const { rec, tool } = build();
    const goal = "x".repeat(200);
    await tool.handler({ ...OK_INPUT, goal });

    const title = rec.taskCreates[0]?.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(rec.taskCreates[0]?.description).toBe(goal);
  });

  it("collapses whitespace in the task title", async () => {
    const { rec, tool } = build();
    await tool.handler({ ...OK_INPUT, goal: "  extract\n\n  the   tables  " });
    expect(rec.taskCreates[0]?.title).toBe("extract the tables");
  });

  it("dispatches a run_repo session under the pre-minted session id, then inserts the repo_run", async () => {
    const { rec, tool } = build();
    const result = await tool.handler(OK_INPUT);

    expect(rec.dispatches).toHaveLength(1);
    const dispatch = rec.dispatches[0]!;
    expect(dispatch).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: OK_INPUT.goal,
      reason: { kind: "fresh" },
    });

    // repo_run.session_id FKs to session.id, so the id the dispatch
    // created the session under must be the one the repo_run carries.
    expect(rec.repoRunCreates).toHaveLength(1);
    expect(rec.repoRunCreates[0]?.session_id).toBe(dispatch.sessionIdOverride);
    expect(result.content.session_id).toBe(dispatch.sessionIdOverride);
  });

  it("ties the repo_run to the container task and the caller, pending", async () => {
    const { rec, tool } = build();
    await tool.handler(OK_INPUT);

    expect(rec.repoRunCreates[0]).toMatchObject({
      task_id: rec.taskCreates[0]?.id,
      agent_id: "agent_caller",
      goal: OK_INPUT.goal,
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });
  });

  it("returns the ids, a pending status and a watch url built from the repo_run id", async () => {
    const { rec, tool } = build();
    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBeFalsy();
    const repoRunId = rec.repoRunCreates[0]?.id as string;
    expect(result.content).toMatchObject({
      repo_run_id: repoRunId,
      task_id: rec.taskCreates[0]?.id,
      status: "pending",
      watch_url: `/capabilities/runs/${repoRunId}`,
    });
  });

  it("echoes trimmed input_url / input_filename back to the caller", async () => {
    const { tool } = build();
    const result = await tool.handler({
      ...OK_INPUT,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("leaves input_url / input_filename undefined when they are not strings", async () => {
    const { tool } = build();
    const result = await tool.handler({ ...OK_INPUT, input_url: 1, input_filename: {} });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limits parsing", () => {
  it("returns an empty object when limits is absent or not an object", async () => {
    const { tool } = build();
    for (const limits of [undefined, null, "20", 5]) {
      const result = await tool.handler({ ...OK_INPUT, limits });
      expect(result.content.limits).toEqual({});
    }
  });

  it("passes sane values through untouched", async () => {
    const { tool } = build();
    const result = await tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 1024 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const { tool } = build();
    const result = await tool.handler({
      ...OK_INPUT,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 999_999,
      },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt / disk values", async () => {
    const { tool } = build();
    const result = await tool.handler({
      ...OK_INPUT,
      limits: { max_install_attempts: 2.9, disk_mb: 512.7 },
    });

    expect(result.content.limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric limits rather than passing them on", async () => {
    const { tool } = build();
    const result = await tool.handler({
      ...OK_INPUT,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      },
    });

    expect(result.content.limits).toEqual({});
  });
});

describe("use_repo failure paths", () => {
  it("surfaces dispatch_failed and never inserts the repo_run", async () => {
    const { rec, tool } = build({ dispatchThrows: new Error("daemon offline") });
    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(rec.repoRunCreates).toHaveLength(0);
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { tool } = build({ dispatchThrows: "boom" });
    const result = await tool.handler(OK_INPUT);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("surfaces repo_run_create_failed rather than silently orphaning the session", async () => {
    const { tool } = build({ repoRunThrows: new Error("fk violation") });
    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { tool } = build({ repoRunThrows: { code: "23503" } });
    const result = await tool.handler(OK_INPUT);
    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof result.content.message).toBe("string");
  });
});
