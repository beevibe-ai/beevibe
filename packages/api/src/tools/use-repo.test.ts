/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB, no daemon).
 *
 * The handler is small but load-bearing: it validates agent-supplied
 * input, mints three ids, and writes two rows in a FK-ordered sequence
 * (dispatch creates `session`, then `repo_run` references it). Each of
 * those steps has its own failure envelope the calling agent branches
 * on, and the ordering comment in the source is a correctness claim —
 * so the tests pin both the envelopes and the call order.
 */

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

const AGENT = "agent_a";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "A",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_container",
    title: "Extract tables",
    status: "pending",
    priority: "medium",
    creator_id: AGENT,
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

interface Harness {
  services: UseRepoServices;
  /** Ordered record of the writes, so FK ordering is assertable. */
  order: string[];
  agentRepo: { findById: ReturnType<typeof vi.fn> };
  taskRepo: { create: ReturnType<typeof vi.fn> };
  repoRunRepo: { create: ReturnType<typeof vi.fn> };
  dispatchService: { dispatchTask: ReturnType<typeof vi.fn> };
}

function harness(
  opts: {
    agent?: Agent | undefined;
    dispatchError?: unknown;
    repoRunError?: unknown;
  } = {},
): Harness {
  const order: string[] = [];
  const agentRepo = {
    findById: vi.fn(async () =>
      "agent" in opts ? opts.agent : fakeAgent(),
    ),
  };
  const taskRepo = {
    create: vi.fn(async (input: { id: string; title: string }) => {
      order.push("task.create");
      return fakeTask({ id: input.id, title: input.title });
    }),
  };
  const dispatchService = {
    dispatchTask: vi.fn(async () => {
      order.push("dispatch");
      if (opts.dispatchError) throw opts.dispatchError;
      return {};
    }),
  };
  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      order.push("repoRun.create");
      if (opts.repoRunError) throw opts.repoRunError;
      return input;
    }),
  };
  return {
    order,
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
    services: {
      agentRepo: agentRepo as unknown as AgentRepository,
      taskRepo: taskRepo as unknown as TaskRepository,
      repoRunRepo: repoRunRepo as unknown as RepoRunRepository,
      dispatchService: dispatchService as unknown as DispatchService,
    },
  };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: AGENT }, h.services);
}

const GOAL = "Extract the tables from this PDF as JSON";
const REPO = "https://github.com/acme/pdf-tables";

describe("use_repo tool descriptor", () => {
  it("exposes the tool name and required schema fields", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    expect(t.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing goal before touching any repo", async () => {
    const h = harness();
    const result = await tool(h).handler({ repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.agentRepo.findById).not.toHaveBeenCalled();
    expect(h.order).toEqual([]);
  });

  it("rejects a whitespace-only goal", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: "   ", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it.each([
    ["missing", undefined],
    ["non-GitHub host", "https://gitlab.com/acme/tool"],
    ["plain http", "http://github.com/acme/tool"],
    ["unparseable", "not-a-url"],
    ["lookalike host", "https://github.com.evil.example/acme/tool"],
  ])("rejects repo_url: %s", async (_label, repoUrl) => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.order).toEqual([]);
  });

  it("accepts a github.com subdomain host", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: GOAL,
      repo_url: "https://www.github.com/acme/tool",
    });

    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const h = harness({ agent: undefined });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.order).toEqual([]);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts repo_run in FK order", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBeFalsy();
    // repo_run.session_id has an FK to session.id, and dispatchTask is
    // what creates the session row — so the insert must come after.
    expect(h.order).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("pins the dispatch to the resolved agent and the pre-minted session id", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    const sessionId = (result.content as { session_id: string }).session_id;
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        type: "run_repo",
        intent: GOAL,
        reason: { kind: "fresh" },
        sessionIdOverride: sessionId,
      }),
    );
  });

  it("writes the repo_run row against the same session and task", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });
    const content = result.content as {
      repo_run_id: string;
      session_id: string;
      task_id: string;
    };

    expect(h.repoRunRepo.create).toHaveBeenCalledWith({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: AGENT,
      goal: GOAL,
      repo_url: REPO,
      status: "pending",
    });
  });

  it("returns the ids, pending status and the UI watch url", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });
    const content = result.content as Record<string, unknown>;

    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    expect(content.task_id).toBe(h.taskRepo.create.mock.calls[0]![0].id);
    expect(typeof content.note).toBe("string");
  });

  it("assigns the container task to the calling agent as both creator and assignee", async () => {
    const h = harness();
    await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(h.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee_id: AGENT,
        creator_id: AGENT,
        creator_type: "agent",
        priority: "medium",
        description: GOAL,
      }),
    );
  });

  it("trims the goal and repo_url before use", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: `  ${GOAL}  `,
      repo_url: `  ${REPO}  `,
    });

    expect(result.isError).toBeFalsy();
    expect(h.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ goal: GOAL, repo_url: REPO }),
    );
  });

  it("passes optional input_url / input_filename straight back to the caller", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: "  https://example.com/doc.pdf  ",
      input_filename: "  doc.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/doc.pdf",
      input_filename: "doc.pdf",
    });
  });

  it("leaves input fields undefined when not supplied", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo container task title", () => {
  it("collapses whitespace in the title while keeping the full goal as description", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "Extract\n  tables\tfrom  the PDF",
      repo_url: REPO,
    });

    const arg = h.taskRepo.create.mock.calls[0]![0];
    expect(arg.title).toBe("Extract tables from the PDF");
    expect(arg.description).toBe("Extract\n  tables\tfrom  the PDF");
  });

  it("truncates a long goal to 80 chars with an ellipsis", async () => {
    const h = harness();
    const longGoal = "x".repeat(200);
    await tool(h).handler({ goal: longGoal, repo_url: REPO });

    const title = h.taskRepo.create.mock.calls[0]![0].title as string;
    expect(title).toHaveLength(78); // 77 chars + the single-char ellipsis
    expect(title.endsWith("…")).toBe(true);
  });

  it("leaves an exactly-80-char goal untouched", async () => {
    const h = harness();
    const goal = "y".repeat(80);
    await tool(h).handler({ goal, repo_url: REPO });

    expect(h.taskRepo.create.mock.calls[0]![0].title).toBe(goal);
  });
});

describe("use_repo limits parsing", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const h = harness();
    const result = await tool(h).handler({
      goal: GOAL,
      repo_url: REPO,
      limits,
    });
    return (result.content as { limits: Record<string, unknown> }).limits;
  }

  it("returns an empty object when limits is absent or not an object", async () => {
    expect(await limitsFor(undefined)).toEqual({});
    expect(await limitsFor("20")).toEqual({});
    expect(await limitsFor(null)).toEqual({});
  });

  it("passes through in-range values unchanged", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 15,
        max_install_attempts: 3,
        disk_mb: 4096,
      }),
    ).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 999_999,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors the integer limits but not the wall clock", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 2.5,
        max_install_attempts: 2.9,
        disk_mb: 1024.7,
      }),
    ).toEqual({
      wall_clock_minutes: 2.5,
      max_install_attempts: 2,
      disk_mb: 1024,
    });
  });

  it("drops non-positive and non-numeric limits rather than clamping them", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      }),
    ).toEqual({});
  });
});

describe("use_repo failure envelopes", () => {
  it("returns dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const h = harness({ dispatchError: new Error("no daemon online") });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(h.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchError: "boom" });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("returns repo_run_create_failed when the repo_run insert throws", async () => {
    const h = harness({ repoRunError: new Error("fk violation") });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
    // The session row already landed — the orphan is surfaced, not hidden.
    expect(h.order).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunError: { code: "23503" } });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof (result.content as { message: string }).message).toBe("string");
  });
});
