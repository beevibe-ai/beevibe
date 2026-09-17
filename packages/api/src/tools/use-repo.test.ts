/**
 * use_repo tool tests.
 *
 * The handler is the Capability Network's write path: validate, mint a
 * container task, dispatch a `run_repo` session, then insert the
 * repo_run row that the daemon's composeDispatchPayload looks up by
 * session_id. The ordering between those last two writes is load-
 * bearing (repo_run.session_id has a FK to session.id), so it is
 * asserted here rather than left to the integration suite.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

interface Harness {
  services: UseRepoServices;
  calls: string[];
  created: { task?: Record<string, unknown>; repoRun?: Record<string, unknown> };
  dispatched: Array<Record<string, unknown>>;
}

function harness(
  overrides: {
    agent?: Record<string, unknown> | null;
    dispatchError?: Error;
    repoRunError?: Error;
  } = {},
): Harness {
  const calls: string[] = [];
  const created: Harness["created"] = {};
  const dispatched: Array<Record<string, unknown>> = [];
  const agent =
    overrides.agent === undefined
      ? { id: "agent_caller", name: "Caller" }
      : overrides.agent;

  const agentRepo = {
    findById: vi.fn(async () => {
      calls.push("agentRepo.findById");
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      calls.push("taskRepo.create");
      created.task = row;
      return row;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      calls.push("repoRunRepo.create");
      if (overrides.repoRunError) throw overrides.repoRunError;
      created.repoRun = row;
      return row;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("dispatchService.dispatchTask");
      if (overrides.dispatchError) throw overrides.dispatchError;
      dispatched.push(input);
      return { session: { id: input.sessionIdOverride } };
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    calls,
    created,
    dispatched,
  };
}

function build(overrides?: Parameters<typeof harness>[0]) {
  const h = harness(overrides);
  const tool = createUseRepoTool({ agentId: "agent_caller" }, h.services);
  return { ...h, tool };
}

describe("use_repo tool descriptor", () => {
  it("exposes the name and required schema fields", () => {
    const { tool } = build();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo validation", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["non-string", 42],
  ])("rejects a %s goal before touching any repo", async (_label, goal) => {
    const { tool, calls } = build();
    const result = await tool.handler({
      goal,
      repo_url: "https://github.com/acme/tool",
    } as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 7],
    ["plain http", "http://github.com/acme/tool"],
    ["a non-github host", "https://gitlab.com/acme/tool"],
    ["a lookalike host", "https://notgithub.com/acme/tool"],
    ["unparseable", "not a url at all"],
    ["an ssh remote", "git@github.com:acme/tool.git"],
  ])("rejects %s repo_url", async (_label, repoUrl) => {
    const { tool, calls } = build();
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: repoUrl,
    } as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(calls).toEqual([]);
  });

  it.each([
    "https://github.com/acme/tool",
    "https://GitHub.com/acme/tool",
    "https://www.github.com/acme/tool",
  ])("accepts %s", async (repoUrl) => {
    const { tool } = build();
    const result = await tool.handler({ goal: "extract tables", repo_url: repoUrl });
    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const { tool, calls } = build({ agent: null });
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // Lookup happened, but nothing was written.
    expect(calls).toEqual(["agentRepo.findById"]);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run — in that order", async () => {
    const { tool, calls, created, dispatched } = build();

    const result = await tool.handler({
      goal: "  Extract the tables from this PDF as JSON  ",
      repo_url: "  https://github.com/jsvine/pdfplumber  ",
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      "agentRepo.findById",
      "taskRepo.create",
      "dispatchService.dispatchTask",
      "repoRunRepo.create",
    ]);

    // Goal and repo_url are trimmed before they are persisted.
    expect(created.task).toMatchObject({
      title: "Extract the tables from this PDF as JSON",
      description: "Extract the tables from this PDF as JSON",
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });
    expect(created.repoRun).toMatchObject({
      goal: "Extract the tables from this PDF as JSON",
      repo_url: "https://github.com/jsvine/pdfplumber",
      agent_id: "agent_caller",
      status: "pending",
    });

    // The pre-minted session id is what ties the three rows together.
    const sessionId = dispatched[0]?.sessionIdOverride;
    expect(typeof sessionId).toBe("string");
    expect(created.repoRun?.session_id).toBe(sessionId);
    expect(created.repoRun?.task_id).toBe(created.task?.id);
    expect(result.content).toMatchObject({
      session_id: sessionId,
      task_id: created.task?.id,
      status: "pending",
    });
  });

  it("dispatches a run_repo session carrying the goal as the intent", async () => {
    const { tool, dispatched, created } = build();
    await tool.handler({
      goal: "download the audio track",
      repo_url: "https://github.com/yt-dlp/yt-dlp",
    });

    expect(dispatched[0]).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: "download the audio track",
      reason: { kind: "fresh" },
    });
    expect(dispatched[0]?.task).toBe(created.task);
  });

  it("returns the watch_url pointing at the minted repo_run", async () => {
    const { tool, created } = build();
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });

    const repoRunId = created.repoRun?.id;
    expect(result.content.repo_run_id).toBe(repoRunId);
    expect(result.content.watch_url).toBe(`/capabilities/runs/${repoRunId}`);
    expect(result.content.note).toContain("Sandbox run started");
  });

  it("truncates a long goal for the container task title but keeps the full description", async () => {
    const { tool, created } = build();
    const goal = "x".repeat(200);
    await tool.handler({ goal, repo_url: "https://github.com/acme/tool" });

    const title = created.task?.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(created.task?.description).toBe(goal);
  });

  it("collapses internal whitespace in the title", async () => {
    const { tool, created } = build();
    await tool.handler({
      goal: "extract\n\ttables   from\n  the PDF",
      repo_url: "https://github.com/acme/tool",
    });
    expect(created.task?.title).toBe("extract tables from the PDF");
  });

  it("keeps an exactly-80-character goal untruncated", async () => {
    const { tool, created } = build();
    const goal = "y".repeat(80);
    await tool.handler({ goal, repo_url: "https://github.com/acme/tool" });
    expect(created.task?.title).toBe(goal);
  });

  it("echoes trimmed input_url / input_filename back to the agent", async () => {
    const { tool } = build();
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("leaves input_url / input_filename undefined when they are not strings", async () => {
    const { tool } = build();
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
      input_url: 12,
    });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limit parsing", () => {
  async function limitsFor(limits: unknown) {
    const { tool } = build();
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
      limits,
    } as Record<string, unknown>);
    return result.content.limits;
  }

  it("passes through in-range limits untouched", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 4096,
      }),
    ).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 999_999,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors the integer limits but not wall_clock_minutes", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 1.5,
        max_install_attempts: 2.9,
        disk_mb: 100.7,
      }),
    ).toEqual({
      wall_clock_minutes: 1.5,
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a string", "20"],
  ])("drops %s values rather than clamping them", async (_label, value) => {
    expect(
      await limitsFor({
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      }),
    ).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a scalar", "unlimited"],
  ])("returns {} when limits is %s", async (_label, raw) => {
    expect(await limitsFor(raw)).toEqual({});
  });

  it("keeps the valid subset when only some limits are usable", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 5, disk_mb: -1 }),
    ).toEqual({ wall_clock_minutes: 5 });
  });
});

describe("use_repo failure paths", () => {
  it("surfaces dispatch_failed without inserting a repo_run", async () => {
    const { tool, calls } = build({ dispatchError: new Error("daemon offline") });
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(calls).not.toContain("repoRunRepo.create");
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { tool } = build({
      dispatchError: "boom" as unknown as Error,
    });
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("surfaces repo_run_create_failed when the orphan-session window is hit", async () => {
    const { tool } = build({ repoRunError: new Error("fk violation") });
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { tool } = build({ repoRunError: "nope" as unknown as Error });
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "nope",
    });
  });
});
