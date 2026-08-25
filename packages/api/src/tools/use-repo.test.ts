/**
 * `use_repo` — the Agent App Store verb. Unit tests with vitest fakes.
 *
 * The handler is pure orchestration over three ports, and the ordering
 * it enforces is load-bearing: `repo_run.session_id` has an FK to
 * `session.id`, so the dispatch (which creates the session row) must
 * land before the repo_run insert. Both failure branches leave the
 * agent with a structured error rather than a silent wait, so both are
 * pinned here alongside the input validation and the limits clamp.
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

const AGENT = "agent_borrower";

interface Harness {
  services: UseRepoServices;
  dispatched: Array<Record<string, unknown>>;
  createdTasks: Array<Record<string, unknown>>;
  createdRuns: Array<Record<string, unknown>>;
}

function makeServices(overrides: Partial<UseRepoServices> = {}): Harness {
  const dispatched: Array<Record<string, unknown>> = [];
  const createdTasks: Array<Record<string, unknown>> = [];
  const createdRuns: Array<Record<string, unknown>> = [];

  const services: UseRepoServices = {
    agentRepo: {
      findById: vi.fn(async (id: string) => ({ id, name: "Borrower" })),
    } as unknown as AgentRepository,
    taskRepo: {
      create: vi.fn(async (row: Record<string, unknown>) => {
        createdTasks.push(row);
        return row as unknown as Task;
      }),
    } as unknown as TaskRepository,
    repoRunRepo: {
      create: vi.fn(async (row: Record<string, unknown>) => {
        createdRuns.push(row);
        return row;
      }),
    } as unknown as RepoRunRepository,
    dispatchService: {
      dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
        dispatched.push(input);
        return { session: { id: input.sessionIdOverride } };
      }),
    } as unknown as DispatchService,
    ...overrides,
  };

  return { services, dispatched, createdTasks, createdRuns };
}

function makeTool(overrides: Partial<UseRepoServices> = {}) {
  const h = makeServices(overrides);
  return { tool: createUseRepoTool({ agentId: AGENT }, h.services), ...h };
}

const GOOD_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool surface", () => {
  it("advertises the name and requires goal + repo_url", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing or blank goal before touching any port", async () => {
    const { tool, services } = makeTool();
    for (const goal of [undefined, "", "   ", 42]) {
      const result = await tool.handler({ ...GOOD_INPUT, goal });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects a repo_url that is not a GitHub HTTPS URL", async () => {
    const { tool, services } = makeTool();
    const bad = [
      undefined,
      "",
      "not a url",
      "http://github.com/o/r", // plain http
      "https://gitlab.com/o/r", // wrong host
      "https://notgithub.com/o/r", // suffix-only match must not pass
      "https://github.com.evil.test/o/r",
    ];
    for (const repo_url of bad) {
      const result = await tool.handler({ ...GOOD_INPUT, repo_url });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    }
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("accepts github.com subdomains over https", async () => {
    const { tool } = makeTool();
    const result = await tool.handler({
      ...GOOD_INPUT,
      repo_url: "https://www.github.com/jsvine/pdfplumber",
    });
    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller's agent row is gone", async () => {
    const { tool, services } = makeTool({
      agentRepo: { findById: vi.fn(async () => null) } as unknown as AgentRepository,
    });
    const result = await tool.handler(GOOD_INPUT);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run in that order", async () => {
    const { tool, createdTasks, dispatched, createdRuns } = makeTool();
    const result = await tool.handler(GOOD_INPUT);

    expect(result.isError).toBeFalsy();
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]).toMatchObject({
      title: GOOD_INPUT.goal,
      description: GOOD_INPUT.goal,
      priority: "medium",
      assignee_id: AGENT,
      creator_id: AGENT,
      creator_type: "agent",
    });

    // The session row has to exist before the repo_run insert (FK).
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      agentId: AGENT,
      type: "run_repo",
      intent: GOOD_INPUT.goal,
      reason: { kind: "fresh" },
    });

    expect(createdRuns).toHaveLength(1);
    expect(createdRuns[0]).toMatchObject({
      session_id: dispatched[0]!.sessionIdOverride,
      task_id: createdTasks[0]!.id,
      agent_id: AGENT,
      goal: GOOD_INPUT.goal,
      repo_url: GOOD_INPUT.repo_url,
      status: "pending",
    });
  });

  it("returns the ids, the watch url and a pending status the agent can poll", async () => {
    const { tool, createdRuns } = makeTool();
    const result = await tool.handler(GOOD_INPUT);

    const runId = createdRuns[0]!.id as string;
    expect(result.content).toMatchObject({
      repo_run_id: runId,
      session_id: createdRuns[0]!.session_id,
      task_id: createdRuns[0]!.task_id,
      status: "pending",
      watch_url: `/capabilities/runs/${runId}`,
    });
    expect(String(result.content.note)).toContain("Sandbox run started");
  });

  it("passes input_url / input_filename through, trimmed, and omits them when absent", async () => {
    const { tool } = makeTool();
    const withInput = await tool.handler({
      ...GOOD_INPUT,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(withInput.content).toMatchObject({
      input_url: "https://example.test/a.pdf",
      input_filename: "a.pdf",
    });

    const without = await tool.handler(GOOD_INPUT);
    expect(without.content.input_url).toBeUndefined();
    expect(without.content.input_filename).toBeUndefined();
  });

  it("truncates a long goal into a scannable container-task title", async () => {
    const { tool, createdTasks } = makeTool();
    const goal = "x".repeat(200);
    await tool.handler({ ...GOOD_INPUT, goal });

    const title = createdTasks[0]!.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The full goal still reaches the child agent via description.
    expect(createdTasks[0]!.description).toBe(goal);
  });

  it("collapses whitespace for the title only — the goal keeps its shape", async () => {
    const { tool, createdTasks, createdRuns } = makeTool();
    await tool.handler({ ...GOOD_INPUT, goal: "  extract\n\n  tables  " });
    // The title is an inbox row, so it gets flattened to one line…
    expect(createdTasks[0]!.title).toBe("extract tables");
    // …but the goal is prompt input for the child agent, so only the
    // outer whitespace goes. Line breaks the human typed are theirs.
    expect(createdTasks[0]!.description).toBe("extract\n\n  tables");
    expect(createdRuns[0]!.goal).toBe("extract\n\n  tables");
  });
});

describe("use_repo limits", () => {
  it("clamps each limit to its ceiling and floors the integer ones", async () => {
    const { tool } = makeTool();
    const result = await tool.handler({
      ...GOOD_INPUT,
      limits: {
        wall_clock_minutes: 999,
        max_install_attempts: 99.9,
        disk_mb: 999_999,
      },
    });
    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("keeps in-range values and floors fractional attempt/disk caps", async () => {
    const { tool } = makeTool();
    const result = await tool.handler({
      ...GOOD_INPUT,
      limits: { wall_clock_minutes: 5, max_install_attempts: 3.7, disk_mb: 512.9 },
    });
    expect(result.content.limits).toEqual({
      wall_clock_minutes: 5,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric limits instead of passing them down", async () => {
    const { tool } = makeTool();
    const result = await tool.handler({
      ...GOOD_INPUT,
      limits: { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: "big" },
    });
    expect(result.content.limits).toEqual({});
  });

  it("treats a missing or non-object limits field as no limits", async () => {
    const { tool } = makeTool();
    for (const limits of [undefined, null, "20", 20]) {
      const result = await tool.handler({ ...GOOD_INPUT, limits });
      expect(result.content.limits).toEqual({});
    }
  });
});

describe("use_repo failure branches", () => {
  it("surfaces a dispatch failure and never inserts the repo_run", async () => {
    const { tool, services, createdRuns } = makeTool({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no runtime available");
        }),
      } as unknown as DispatchService,
    });

    const result = await tool.handler(GOOD_INPUT);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime available",
    });
    expect(createdRuns).toHaveLength(0);
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("surfaces a repo_run insert failure so the agent doesn't wait on an orphan session", async () => {
    const { tool } = makeTool({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw new Error("duplicate key");
        }),
      } as unknown as RepoRunRepository,
    });

    const result = await tool.handler(GOOD_INPUT);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error throw from either port", async () => {
    const dispatchThrew = makeTool({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw "boom";
        }),
      } as unknown as DispatchService,
    });
    expect((await dispatchThrew.tool.handler(GOOD_INPUT)).content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });

    const insertThrew = makeTool({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw "boom";
        }),
      } as unknown as RepoRunRepository,
    });
    expect((await insertThrew.tool.handler(GOOD_INPUT)).content).toMatchObject({
      error: "repo_run_create_failed",
      message: "boom",
    });
  });
});
