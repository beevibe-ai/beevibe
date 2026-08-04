/**
 * Tests for the use_repo MCP tool — the Capability Network's verb.
 *
 * The handler is a four-step orchestration (validate → container task →
 * dispatch → repo_run insert) whose ordering is load-bearing:
 * `repo_run.session_id` has an FK to `session.id`, so the pre-minted
 * session id must reach `dispatchTask` before the repo_run insert uses
 * it. Both write steps also have a documented partial-failure story
 * that the agent is supposed to see rather than silently wait through.
 *
 * The input guards matter for a different reason: `repo_url` reaches a
 * `git clone` inside the sandbox, so the GitHub-HTTPS check is the one
 * piece of validation between an agent's free-text argument and a
 * clone, and it needs to reject by hostname rather than by substring.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool } from "./use-repo.js";

interface Harness {
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  repoRunRepo: RepoRunRepository;
  dispatchService: DispatchService;
}

function harness(over: Partial<Harness> = {}): Harness {
  const agentRepo = {
    findById: vi.fn(async (id: string) => ({ id, name: "Borrower" })),
  } as unknown as AgentRepository;
  const taskRepo = {
    create: vi.fn(async (input: Partial<Task>) => ({
      ...input,
      status: "pending",
    })),
  } as unknown as TaskRepository;
  const repoRunRepo = {
    create: vi.fn(async (input: unknown) => input),
  } as unknown as RepoRunRepository;
  const dispatchService = {
    dispatchTask: vi.fn(async () => undefined),
  } as unknown as DispatchService;
  return { agentRepo, taskRepo, repoRunRepo, dispatchService, ...over };
}

const CTX = { agentId: "agent_caller" };
const GOAL = "Extract the tables from this PDF as JSON";
const REPO = "https://github.com/jsvine/pdfplumber";

describe("use_repo descriptor", () => {
  it("requires goal and repo_url and rejects unknown properties", () => {
    const tool = createUseRepoTool(CTX, harness());
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing or blank goal before touching any repo", async () => {
    const h = harness();
    const tool = createUseRepoTool(CTX, h);

    for (const input of [{ repo_url: REPO }, { goal: "   ", repo_url: REPO }, { goal: 5, repo_url: REPO }]) {
      const result = await tool.handler(input);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(h.agentRepo.findById).not.toHaveBeenCalled();
    expect(h.taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["plain http", "http://github.com/o/r"],
    ["a lookalike host", "https://github.com.evil.test/o/r"],
    ["a different forge", "https://gitlab.com/o/r"],
    ["unparseable", "not a url"],
    ["an ssh remote", "git@github.com:o/r.git"],
  ])("rejects %s repo_url", async (_label, repo_url) => {
    const h = harness();
    const tool = createUseRepoTool(CTX, h);

    const result = await tool.handler({ goal: GOAL, ...(repo_url === undefined ? {} : { repo_url }) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.taskRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a github.com subdomain host", async () => {
    const tool = createUseRepoTool(CTX, harness());
    const result = await tool.handler({
      goal: GOAL,
      repo_url: "https://www.github.com/jsvine/pdfplumber",
    });
    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const h = harness({
      agentRepo: { findById: vi.fn(async () => null) } as unknown as AgentRepository,
    });
    const tool = createUseRepoTool(CTX, h);

    const result = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo limits parsing", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const tool = createUseRepoTool(CTX, harness());
    const result = await tool.handler({ goal: GOAL, repo_url: REPO, limits });
    return result.content.limits as Record<string, unknown>;
  }

  it("passes through in-range values", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 4096 }),
    ).toEqual({ wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 4096 });
  });

  it("caps each limit at its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors the two integer limits but leaves wall clock fractional", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 2.5, max_install_attempts: 3.9, disk_mb: 512.7 }),
    ).toEqual({ wall_clock_minutes: 2.5, max_install_attempts: 3, disk_mb: 512 });
  });

  it("drops non-positive and non-numeric entries", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: "2048" }),
    ).toEqual({});
  });

  it("treats a missing or non-object limits argument as no limits", async () => {
    expect(await limitsFor(undefined)).toEqual({});
    expect(await limitsFor("20m")).toEqual({});
    expect(await limitsFor(null)).toEqual({});
  });
});

describe("use_repo happy path", () => {
  it("creates a container task assigned to and created by the caller", async () => {
    const h = harness();
    const tool = createUseRepoTool(CTX, h);

    await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(h.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: GOAL,
        description: GOAL,
        priority: "medium",
        assignee_id: "agent_caller",
        creator_id: "agent_caller",
        creator_type: "agent",
      }),
    );
  });

  it("truncates an overlong goal into a scannable task title", async () => {
    const h = harness();
    const tool = createUseRepoTool(CTX, h);
    const longGoal = "Extract   every  table ".repeat(20);

    await tool.handler({ goal: longGoal, repo_url: REPO });

    const title = vi.mocked(h.taskRepo.create).mock.calls[0]?.[0].title as string;
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
    // Whitespace is collapsed before the cut, so the title is one line.
    expect(title).not.toMatch(/\s\s/);
  });

  it("dispatches a run_repo session under the pre-minted id, then inserts the repo_run against it", async () => {
    const h = harness();
    const tool = createUseRepoTool(CTX, h);

    const result = await tool.handler({ goal: GOAL, repo_url: REPO });

    const dispatched = vi.mocked(h.dispatchService.dispatchTask).mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: GOAL,
      reason: { kind: "fresh" },
    });
    const sessionIdValue = dispatched?.sessionIdOverride;
    expect(sessionIdValue).toMatch(/^sess_/);

    // The FK direction: session must exist first, and the repo_run has
    // to reference exactly the session that was dispatched.
    const dispatchOrder = vi.mocked(h.dispatchService.dispatchTask).mock
      .invocationCallOrder[0]!;
    const insertOrder = vi.mocked(h.repoRunRepo.create).mock
      .invocationCallOrder[0]!;
    expect(dispatchOrder).toBeLessThan(insertOrder);

    expect(h.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: sessionIdValue,
        agent_id: "agent_caller",
        goal: GOAL,
        repo_url: REPO,
        status: "pending",
      }),
    );
    expect(result.content.session_id).toBe(sessionIdValue);
  });

  it("returns the ids, watch url and echoed input for the agent to poll on", async () => {
    const tool = createUseRepoTool(CTX, harness());

    const result = await tool.handler({
      goal: `  ${GOAL}  `,
      repo_url: `  ${REPO}  `,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Record<string, string>;
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.task_id).toMatch(/^task_/);
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    // Trimmed on the way in — a trailing space would break the clone.
    expect(content.input_url).toBe("https://example.com/report.pdf");
    expect(content.input_filename).toBe("report.pdf");
  });

  it("leaves the optional input fields undefined when not supplied", async () => {
    const tool = createUseRepoTool(CTX, harness());
    const result = await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo partial failure", () => {
  it("surfaces a dispatch failure and never inserts the repo_run", async () => {
    const h = harness({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no daemon online");
        }),
      } as unknown as DispatchService,
    });
    const tool = createUseRepoTool(CTX, h);

    const result = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(h.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("surfaces an orphaned session when the repo_run insert fails", async () => {
    const h = harness({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw new Error("duplicate key");
        }),
      } as unknown as RepoRunRepository,
    });
    const tool = createUseRepoTool(CTX, h);

    const result = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error throw from either write", async () => {
    const h = harness({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw "socket hang up";
        }),
      } as unknown as DispatchService,
    });
    const tool = createUseRepoTool(CTX, h);

    const result = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(result.content).toMatchObject({ message: "socket hang up" });
  });
});
