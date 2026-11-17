/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The tool is a closure over four ports, so a bag of `vi.fn()` services
 * reaches every branch: the two input validations, the agent lookup,
 * the container-task insert, the dispatch + repo_run ordering (and each
 * of their failure envelopes), and the happy-path response shape.
 *
 * The limits clamp and the container-task title truncation are private
 * helpers with no other call site — they're exercised through the
 * handler, which is also where the wire contract that agents branch on
 * lives.
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
import type { AgentToolResult } from "./types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

const AGENT_ID = "agent_borrower";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Borrower",
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
    title: "Extract the tables",
    status: "pending",
    priority: "medium",
    creator_id: AGENT_ID,
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

interface Harness {
  services: UseRepoServices;
  agentFindById: ReturnType<typeof vi.fn>;
  taskCreate: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  repoRunCreate: ReturnType<typeof vi.fn>;
}

function harness(overrides: {
  agent?: Agent | null;
  // `never[]` rest params so a stub may declare the argument it cares
  // about (the repo_run row) or ignore arguments entirely.
  dispatchImpl?: (...args: never[]) => unknown;
  repoRunImpl?: (...args: never[]) => unknown;
} = {}): Harness {
  const agent = overrides.agent === undefined ? fakeAgent() : overrides.agent;
  const agentFindById = vi.fn().mockResolvedValue(agent);
  // The handler mints the task id itself; pin it to a known value so the
  // assertions below can follow it into dispatch + repo_run.
  const taskCreate = vi
    .fn()
    .mockImplementation(async (row: Partial<Task>) =>
      fakeTask({ ...row, id: "task_container" }),
    );
  const dispatchTask = vi
    .fn()
    .mockImplementation(
      overrides.dispatchImpl ??
        (async () => ({ session: { id: "sess_x" }, runtime_id: null })),
    );
  const repoRunCreate = vi
    .fn()
    .mockImplementation(
      overrides.repoRunImpl ?? (async (row: RepoRun) => row),
    );

  const services = {
    agentRepo: { findById: agentFindById } as unknown as AgentRepository,
    taskRepo: { create: taskCreate } as unknown as TaskRepository,
    repoRunRepo: { create: repoRunCreate } as unknown as RepoRunRepository,
    dispatchService: { dispatchTask } as unknown as DispatchService,
  };

  return { services, agentFindById, taskCreate, dispatchTask, repoRunCreate };
}

function call(
  input: Record<string, unknown>,
  h: Harness = harness(),
): Promise<AgentToolResult> {
  return createUseRepoTool({ agentId: AGENT_ID }, h.services).handler(input);
}

// ── Static surface ───────────────────────────────────────────────────────

describe("createUseRepoTool — tool definition", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const tool = createUseRepoTool({ agentId: AGENT_ID }, harness().services);
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    // The description is the agent-facing contract for when to reach for
    // a sandboxed install instead of reporting a blocker.
    expect(tool.description).toContain("Docker sandbox");
  });
});

// ── Input validation ─────────────────────────────────────────────────────

describe("createUseRepoTool — input validation", () => {
  it.each([
    ["missing goal", {}],
    ["empty goal", { goal: "   " }],
    ["non-string goal", { goal: 42 }],
  ])("rejects %s with invalid_goal before touching any service", async (_label, input) => {
    const h = harness();
    const res = await call({ repo_url: "https://github.com/o/r", ...input }, h);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(h.agentFindById).not.toHaveBeenCalled();
    expect(h.taskCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing repo_url", undefined],
    ["non-GitHub host", "https://gitlab.com/o/r"],
    ["http, not https", "http://github.com/o/r"],
    ["unparseable", "not a url"],
    ["lookalike host", "https://notgithub.com/o/r"],
    ["github as a path segment only", "https://evil.example.com/github.com/o/r"],
  ])("rejects %s with invalid_repo_url", async (_label, repoUrl) => {
    const h = harness();
    const res = await call(
      { goal: "do a thing", ...(repoUrl === undefined ? {} : { repo_url: repoUrl }) },
      h,
    );
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(h.taskCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["apex host", "https://github.com/owner/repo"],
    ["www subdomain", "https://www.github.com/owner/repo"],
  ])("accepts %s", async (_label, repoUrl) => {
    const res = await call({ goal: "do a thing", repo_url: repoUrl });
    expect(res.isError).toBeUndefined();
  });
});

// ── Caller resolution ────────────────────────────────────────────────────

describe("createUseRepoTool — caller resolution", () => {
  it("returns agent_not_found when the token's agent row is gone", async () => {
    const h = harness({ agent: null });
    const res = await call({ goal: "g", repo_url: "https://github.com/o/r" }, h);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(h.agentFindById).toHaveBeenCalledWith(AGENT_ID);
    // No container task for a caller that doesn't exist.
    expect(h.taskCreate).not.toHaveBeenCalled();
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });
});

// ── Happy path ───────────────────────────────────────────────────────────

describe("createUseRepoTool — happy path", () => {
  it("creates the container task with the agent as both creator and assignee", async () => {
    const h = harness();
    await call({ goal: "Extract tables from this PDF", repo_url: "https://github.com/o/r" }, h);
    const row = h.taskCreate.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      title: "Extract tables from this PDF",
      description: "Extract tables from this PDF",
      priority: "medium",
      assignee_id: AGENT_ID,
      creator_id: AGENT_ID,
      creator_type: "agent",
    });
    expect(row.id).toMatch(/^task_/);
  });

  it("collapses whitespace and truncates a long goal into the task title", async () => {
    const h = harness();
    const goal = "a".repeat(200);
    await call({ goal, repo_url: "https://github.com/o/r" }, h);
    const title: string = h.taskCreate.mock.calls[0]?.[0].title;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The untruncated goal still reaches the child agent as description.
    expect(h.taskCreate.mock.calls[0]?.[0].description).toBe(goal);
  });

  it("normalizes interior whitespace in the title", async () => {
    const h = harness();
    await call({ goal: "  rip   the\n\naudio  ", repo_url: "https://github.com/o/r" }, h);
    expect(h.taskCreate.mock.calls[0]?.[0].title).toBe("rip the audio");
  });

  it("dispatches a run_repo session under a pre-minted session id", async () => {
    const h = harness();
    const res = await call({ goal: "g", repo_url: "https://github.com/o/r" }, h);
    const dispatch = h.dispatchTask.mock.calls[0]?.[0];
    expect(dispatch).toMatchObject({
      agentId: AGENT_ID,
      type: "run_repo",
      intent: "g",
      reason: { kind: "fresh" },
    });
    expect(dispatch.task.id).toBe("task_container");
    // The override is what lets the repo_run FK resolve, so it has to be
    // the same id the response hands back to the agent.
    expect(dispatch.sessionIdOverride).toBe(res.content.session_id);
  });

  it("inserts repo_run AFTER dispatch so the session FK resolves", async () => {
    const order: string[] = [];
    const h = harness({
      dispatchImpl: async () => {
        order.push("dispatch");
        return { session: { id: "sess_x" }, runtime_id: null };
      },
      repoRunImpl: async (row: RepoRun) => {
        order.push("repo_run");
        return row;
      },
    });
    await call({ goal: "g", repo_url: "https://github.com/o/r" }, h);
    expect(order).toEqual(["dispatch", "repo_run"]);
  });

  it("stores the repo_run as pending, keyed to the dispatched session and task", async () => {
    const h = harness();
    const res = await call(
      { goal: "g", repo_url: "https://github.com/owner/repo" },
      h,
    );
    const row = h.repoRunCreate.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      session_id: res.content.session_id,
      task_id: "task_container",
      agent_id: AGENT_ID,
      goal: "g",
      repo_url: "https://github.com/owner/repo",
      status: "pending",
    });
    expect(row.id).toBe(res.content.repo_run_id);
  });

  it("returns the ids, a pending status and the live-transcript watch url", async () => {
    const res = await call({ goal: "g", repo_url: "https://github.com/o/r" });
    expect(res.isError).toBeUndefined();
    expect(res.content.repo_run_id).toMatch(/^repo_/);
    expect(res.content.session_id).toMatch(/^sess_/);
    expect(res.content.task_id).toBe("task_container");
    expect(res.content.status).toBe("pending");
    expect(res.content.watch_url).toBe(
      `/capabilities/runs/${res.content.repo_run_id}`,
    );
    // The note is the anti-busy-loop hint; agents read it instead of
    // calling use_repo again while one is in flight.
    expect(String(res.content.note)).toContain("poll");
  });

  it("trims surrounding whitespace off the goal and repo_url", async () => {
    const h = harness();
    await call(
      { goal: "  g  ", repo_url: "  https://github.com/o/r  " },
      h,
    );
    expect(h.repoRunCreate.mock.calls[0]?.[0]).toMatchObject({
      goal: "g",
      repo_url: "https://github.com/o/r",
    });
  });
});

// ── Optional input passthrough ───────────────────────────────────────────

describe("createUseRepoTool — input_url / input_filename", () => {
  it("echoes both back trimmed when present", async () => {
    const res = await call({
      goal: "g",
      repo_url: "https://github.com/o/r",
      input_url: "  https://example.com/a.pdf ",
      input_filename: " a.pdf ",
    });
    expect(res.content.input_url).toBe("https://example.com/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("leaves both undefined when absent or the wrong type", async () => {
    const res = await call({
      goal: "g",
      repo_url: "https://github.com/o/r",
      input_url: 7,
    });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

// ── Limits clamp ─────────────────────────────────────────────────────────

describe("createUseRepoTool — limits", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const res = await call({ goal: "g", repo_url: "https://github.com/o/r", limits });
    return res.content.limits as Record<string, unknown>;
  }

  it("passes in-range values through unchanged", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 4096 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 4096 });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 50,
        disk_mb: 1_000_000,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors fractional attempt and disk values", async () => {
    expect(await limitsFor({ max_install_attempts: 2.9, disk_mb: 512.7 })).toEqual({
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric values instead of clamping them up", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "big",
      }),
    ).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a scalar", 5],
  ])("returns {} when limits is %s", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });
});

// ── Failure envelopes ────────────────────────────────────────────────────

describe("createUseRepoTool — failure envelopes", () => {
  it("surfaces a dispatch throw as dispatch_failed and never inserts repo_run", async () => {
    const h = harness({
      dispatchImpl: async () => {
        throw new Error("no runtime bound");
      },
    });
    const res = await call({ goal: "g", repo_url: "https://github.com/o/r" }, h);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime bound",
    });
    expect(h.repoRunCreate).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({
      dispatchImpl: async () => {
        throw "plain string";
      },
    });
    const res = await call({ goal: "g", repo_url: "https://github.com/o/r" }, h);
    expect(res.content.message).toBe("plain string");
  });

  it("surfaces a repo_run insert failure rather than letting the agent wait on an orphan session", async () => {
    const h = harness({
      repoRunImpl: async () => {
        throw new Error("duplicate key");
      },
    });
    const res = await call({ goal: "g", repo_url: "https://github.com/o/r" }, h);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({
      repoRunImpl: async () => {
        throw { code: 23503 };
      },
    });
    const res = await call({ goal: "g", repo_url: "https://github.com/o/r" }, h);
    expect(res.content.error).toBe("repo_run_create_failed");
    expect(typeof res.content.message).toBe("string");
  });
});
