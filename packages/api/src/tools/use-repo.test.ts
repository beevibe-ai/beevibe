import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const AGENT = { id: "agent_caller", label: "Caller" } as unknown as Agent;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_container",
    title: "t",
    status: "pending",
    priority: "medium",
    creator_id: AGENT.id,
    creator_type: "agent",
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides,
  } as Task;
}

interface Stubs {
  services: UseRepoServices;
  findById: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  createRepoRun: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
}

function stubs(overrides: Partial<Omit<Stubs, "services">> = {}): Stubs {
  const findById = overrides.findById ?? vi.fn(async () => AGENT);
  // Returns a fixed id, distinct from the one the tool minted, so the
  // assertions below prove the tool threads the *persisted* row's id
  // onto the repo_run and the response.
  const createTask =
    overrides.createTask ??
    vi.fn(async (row: Partial<Task>) => task({ title: row.title }));
  const createRepoRun = overrides.createRepoRun ?? vi.fn(async () => undefined);
  const dispatchTask = overrides.dispatchTask ?? vi.fn(async () => ({}));
  return {
    findById,
    createTask,
    createRepoRun,
    dispatchTask,
    services: {
      agentRepo: { findById } as unknown as AgentRepository,
      taskRepo: { create: createTask } as unknown as TaskRepository,
      repoRunRepo: { create: createRepoRun } as unknown as RepoRunRepository,
      dispatchService: { dispatchTask } as unknown as DispatchService,
    },
  };
}

function tool(s: Stubs) {
  return createUseRepoTool({ agentId: AGENT.id }, s.services);
}

const GOAL = "Extract the tables from this PDF as JSON";
const REPO = "https://github.com/jsvine/pdfplumber";

describe("use_repo tool shape", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(stubs());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    expect(t.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing, blank, or non-string goal before touching any repo", async () => {
    const s = stubs();
    const t = tool(s);

    for (const input of [{ repo_url: REPO }, { goal: "   ", repo_url: REPO }, { goal: 1, repo_url: REPO }]) {
      const result = await t.handler(input as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(s.findById).not.toHaveBeenCalled();
    expect(s.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["http (not https)", "http://github.com/o/r"],
    ["a non-GitHub host", "https://gitlab.com/o/r"],
    ["a lookalike host", "https://github.com.evil.example/o/r"],
    ["unparseable", "not a url"],
  ])("rejects %s repo_url", async (_label, repoUrl) => {
    const s = stubs();
    const result = await tool(s).handler({
      goal: GOAL,
      ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(s.createTask).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/o/r",
    "https://GitHub.com/o/r",
    "https://www.github.com/o/r",
  ])("accepts %s", async (repoUrl) => {
    const s = stubs();
    const result = await tool(s).handler({ goal: GOAL, repo_url: repoUrl });
    expect(result.isError).toBeFalsy();
  });

  it("reports agent_not_found when the caller does not resolve", async () => {
    const s = stubs({ findById: vi.fn(async () => undefined) });
    const result = await tool(s).handler({ goal: GOAL, repo_url: REPO });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(s.createTask).not.toHaveBeenCalled();
    expect(s.dispatchTask).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("creates a container task titled from the goal and pinned to the caller", async () => {
    const s = stubs();
    await tool(s).handler({ goal: `  ${GOAL}  `, repo_url: REPO });

    expect(s.createTask).toHaveBeenCalledTimes(1);
    expect(s.createTask.mock.calls[0]?.[0]).toMatchObject({
      title: GOAL,
      description: GOAL,
      priority: "medium",
      assignee_id: AGENT.id,
      creator_id: AGENT.id,
      creator_type: "agent",
    });
    expect((s.createTask.mock.calls[0]?.[0] as { id: string }).id).toMatch(/^task_/);
  });

  it("collapses whitespace and truncates a long goal into an 80-char title", async () => {
    const s = stubs();
    const longGoal = "word ".repeat(40).trim();
    await tool(s).handler({ goal: longGoal, repo_url: REPO });

    const title = (s.createTask.mock.calls[0]?.[0] as { title: string }).title;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The description keeps the untruncated goal.
    expect((s.createTask.mock.calls[0]?.[0] as { description: string }).description).toBe(
      longGoal,
    );
  });

  it("does not truncate a goal that already fits", async () => {
    const s = stubs();
    await tool(s).handler({ goal: "a".repeat(80), repo_url: REPO });
    const title = (s.createTask.mock.calls[0]?.[0] as { title: string }).title;
    expect(title).toBe("a".repeat(80));
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const s = stubs();
    const result = await tool(s).handler({ goal: GOAL, repo_url: REPO });

    expect(s.dispatchTask).toHaveBeenCalledTimes(1);
    const dispatched = s.dispatchTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(dispatched).toMatchObject({
      agentId: AGENT.id,
      type: "run_repo",
      intent: GOAL,
      reason: { kind: "fresh" },
    });
    expect(dispatched.sessionIdOverride).toBe(
      (result.content as { session_id: string }).session_id,
    );
    expect((dispatched.task as Task).id).toBe("task_container");
  });

  it("inserts the repo_run row after the dispatch so the session FK resolves", async () => {
    const order: string[] = [];
    const s = stubs({
      dispatchTask: vi.fn(async () => {
        order.push("dispatch");
        return {};
      }),
      createRepoRun: vi.fn(async () => {
        order.push("repo_run");
      }),
    });
    const result = await tool(s).handler({ goal: GOAL, repo_url: REPO });

    expect(order).toEqual(["dispatch", "repo_run"]);
    const content = result.content as { repo_run_id: string; session_id: string };
    expect(s.createRepoRun.mock.calls[0]?.[0]).toEqual({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: "task_container",
      agent_id: AGENT.id,
      goal: GOAL,
      repo_url: REPO,
      status: "pending",
    });
  });

  it("returns the ids, pending status, watch url and echoed inputs", async () => {
    const s = stubs();
    const result = await tool(s).handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: "  https://example.com/doc.pdf  ",
      input_filename: "  doc.pdf  ",
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Record<string, unknown>;
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.task_id).toBe("task_container");
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${String(content.repo_run_id)}`);
    expect(content.input_url).toBe("https://example.com/doc.pdf");
    expect(content.input_filename).toBe("doc.pdf");
    expect(content.note).toContain("Sandbox run started");
  });

  it("omits input_url / input_filename when they are absent or not strings", async () => {
    const s = stubs();
    const result = await tool(s).handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: 5,
    });
    const content = result.content as Record<string, unknown>;
    expect(content.input_url).toBeUndefined();
    expect(content.input_filename).toBeUndefined();
  });

  it("does not forward the raw input_url to the repo_run row", async () => {
    const s = stubs();
    await tool(s).handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: "https://example.com/doc.pdf",
    });
    expect(s.createRepoRun.mock.calls[0]?.[0]).not.toHaveProperty("input_url");
  });
});

describe("use_repo limit parsing", () => {
  it("returns an empty limits object when limits is absent or not an object", async () => {
    const s = stubs();
    for (const limits of [undefined, null, "big", 7]) {
      const result = await tool(s).handler({
        goal: GOAL,
        repo_url: REPO,
        ...(limits === undefined ? {} : { limits }),
      });
      expect((result.content as { limits: unknown }).limits).toEqual({});
    }
  });

  it("passes through in-range limits, flooring the integer ones", async () => {
    const s = stubs();
    const result = await tool(s).handler({
      goal: GOAL,
      repo_url: REPO,
      limits: { wall_clock_minutes: 12.5, max_install_attempts: 3.9, disk_mb: 1024.7 },
    });
    expect((result.content as { limits: unknown }).limits).toEqual({
      wall_clock_minutes: 12.5,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const s = stubs();
    const result = await tool(s).handler({
      goal: GOAL,
      repo_url: REPO,
      limits: { wall_clock_minutes: 999, max_install_attempts: 50, disk_mb: 999_999 },
    });
    expect((result.content as { limits: unknown }).limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("drops zero, negative and non-numeric limit values", async () => {
    const s = stubs();
    const result = await tool(s).handler({
      goal: GOAL,
      repo_url: REPO,
      limits: { wall_clock_minutes: 0, max_install_attempts: -2, disk_mb: "2048" },
    });
    expect((result.content as { limits: unknown }).limits).toEqual({});
  });
});

describe("use_repo failure paths", () => {
  it("reports dispatch_failed with the thrown message and skips the repo_run insert", async () => {
    const s = stubs({
      dispatchTask: vi.fn(async () => {
        throw new Error("no runtime bound");
      }),
    });
    const result = await tool(s).handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime bound",
    });
    expect(s.createRepoRun).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const s = stubs({
      dispatchTask: vi.fn(async () => {
        throw "boom";
      }),
    });
    const result = await tool(s).handler({ goal: GOAL, repo_url: REPO });
    expect(result.content).toEqual({ error: "dispatch_failed", message: "boom" });
  });

  it("reports repo_run_create_failed when the row insert throws", async () => {
    const s = stubs({
      createRepoRun: vi.fn(async () => {
        throw new Error("fk violation");
      }),
    });
    const result = await tool(s).handler({ goal: GOAL, repo_url: REPO });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const s = stubs({
      createRepoRun: vi.fn(async () => {
        throw 42;
      }),
    });
    const result = await tool(s).handler({ goal: GOAL, repo_url: REPO });
    expect(result.content).toEqual({ error: "repo_run_create_failed", message: "42" });
  });
});
