/**
 * use_repo tool tests.
 *
 * The handler is pure orchestration over four injected collaborators, so
 * everything here runs on fakes — no Postgres, no daemon, no Docker. What
 * matters and is locked down below:
 *
 *   - input validation happens BEFORE any write (a bad repo_url must not
 *     leave a container task behind),
 *   - the session row is created before the repo_run insert, because
 *     repo_run.session_id has an FK to session.id,
 *   - the pre-minted session id handed to dispatchTask is the same one
 *     stamped on the repo_run and echoed back to the agent,
 *   - limits are clamped to the caps the sandbox actually enforces.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, RepoRunRepository, TaskRepository } from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

interface Harness {
  services: UseRepoServices;
  /** Ordered record of collaborator calls — proves write ordering. */
  order: string[];
  created: { tasks: unknown[]; repoRuns: unknown[]; dispatches: unknown[] };
}

function harness(
  overrides: {
    agent?: { id: string } | null;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const order: string[] = [];
  const created = {
    tasks: [] as unknown[],
    repoRuns: [] as unknown[],
    dispatches: [] as unknown[],
  };
  const agent = overrides.agent === undefined ? { id: "agent_caller" } : overrides.agent;

  const agentRepo = {
    findById: vi.fn(async () => {
      order.push("agent.findById");
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      order.push("task.create");
      created.tasks.push(input);
      return { ...input };
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      order.push("repoRun.create");
      if (overrides.repoRunThrows) throw overrides.repoRunThrows;
      created.repoRuns.push(input);
      return { ...input };
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      order.push("dispatch.dispatchTask");
      if (overrides.dispatchThrows) throw overrides.dispatchThrows;
      created.dispatches.push(input);
      return {};
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    order,
    created,
  };
}

function build(h: Harness) {
  return createUseRepoTool({ agentId: "agent_caller" }, h.services);
}

const GOOD = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool descriptor", () => {
  it("exposes goal + repo_url as the required inputs", () => {
    const tool = build(harness());
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo validation", () => {
  it("rejects a blank goal without touching any repository", async () => {
    const h = harness();
    const result = await build(h).handler({ goal: "   ", repo_url: GOOD.repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.order).toEqual([]);
  });

  it("rejects a missing goal", async () => {
    const h = harness();
    const result = await build(h).handler({ repo_url: GOOD.repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  // The sandbox clones whatever URL it is handed, so the host allowlist is
  // this check. Each case below would otherwise reach `git clone`.
  it.each([
    ["a non-GitHub host", "https://gitlab.com/foo/bar"],
    ["plain http", "http://github.com/foo/bar"],
    ["a lookalike suffix domain", "https://notgithub.com/foo/bar"],
    ["an ssh remote", "git@github.com:foo/bar.git"],
    ["unparseable junk", "not a url at all"],
    ["an empty string", ""],
  ])("rejects %s", async (_label, repo_url) => {
    const h = harness();
    const result = await build(h).handler({ goal: GOOD.goal, repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.order).toEqual([]);
  });

  it("accepts a github.com subdomain over https", async () => {
    const h = harness();
    const result = await build(h).handler({
      goal: GOOD.goal,
      repo_url: "https://www.github.com/foo/bar",
    });

    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const h = harness({ agent: null });
    const result = await build(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // Looked the agent up, then stopped — no container task orphaned.
    expect(h.order).toEqual(["agent.findById"]);
  });
});

describe("use_repo happy path", () => {
  it("creates the session before the repo_run (FK ordering)", async () => {
    const h = harness();
    await build(h).handler(GOOD);

    expect(h.order).toEqual([
      "agent.findById",
      "task.create",
      "dispatch.dispatchTask",
      "repoRun.create",
    ]);
  });

  it("stamps the same pre-minted session id on dispatch, repo_run, and the reply", async () => {
    const h = harness();
    const result = await build(h).handler(GOOD);

    const dispatched = h.created.dispatches[0] as Record<string, unknown>;
    const repoRun = h.created.repoRuns[0] as Record<string, unknown>;
    const content = result.content as Record<string, unknown>;

    expect(dispatched.sessionIdOverride).toMatch(/^sess_/);
    expect(repoRun.session_id).toBe(dispatched.sessionIdOverride);
    expect(content.session_id).toBe(dispatched.sessionIdOverride);
  });

  it("returns the ids, pending status, and a watch url built from the run id", async () => {
    const h = harness();
    const result = await build(h).handler(GOOD);
    const content = result.content as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.task_id).toMatch(/^task_/);
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
  });

  it("dispatches a run_repo session for the resolved agent with the goal as intent", async () => {
    const h = harness();
    await build(h).handler(GOOD);

    expect(h.created.dispatches[0]).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
    });
  });

  it("pins the container task to the agent as both assignee and creator", async () => {
    const h = harness();
    await build(h).handler(GOOD);

    expect(h.created.tasks[0]).toMatchObject({
      description: GOOD.goal,
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });
  });

  it("trims surrounding whitespace off goal and repo_url", async () => {
    const h = harness();
    await build(h).handler({
      goal: `  ${GOOD.goal}  `,
      repo_url: `  ${GOOD.repo_url}  `,
    });

    expect(h.created.repoRuns[0]).toMatchObject({
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
    });
  });

  it("passes optional input_url / input_filename back to the agent", async () => {
    const h = harness();
    const result = await build(h).handler({
      ...GOOD,
      input_url: "  https://example.com/doc.pdf  ",
      input_filename: "  doc.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/doc.pdf",
      input_filename: "doc.pdf",
    });
  });

  it("leaves input_url / input_filename undefined when omitted", async () => {
    const h = harness();
    const result = await build(h).handler(GOOD);
    const content = result.content as Record<string, unknown>;

    expect(content.input_url).toBeUndefined();
    expect(content.input_filename).toBeUndefined();
  });
});

describe("use_repo container task title", () => {
  it("collapses runs of whitespace", async () => {
    const h = harness();
    await build(h).handler({
      ...GOOD,
      goal: "Extract\n\n  tables   from\tthis PDF",
    });

    expect(h.created.tasks[0]).toMatchObject({
      title: "Extract tables from this PDF",
    });
  });

  it("truncates a long goal to 80 chars with an ellipsis, keeping the full goal as description", async () => {
    const h = harness();
    const goal = "x".repeat(200);
    await build(h).handler({ ...GOOD, goal });

    const task = h.created.tasks[0] as Record<string, unknown>;
    expect(task.title).toBe("x".repeat(77) + "…");
    expect(String(task.title)).toHaveLength(78);
    expect(task.description).toBe(goal);
  });

  it("leaves an exactly-80-char goal untruncated", async () => {
    const h = harness();
    const goal = "y".repeat(80);
    await build(h).handler({ ...GOOD, goal });

    expect(h.created.tasks[0]).toMatchObject({ title: goal });
  });
});

describe("use_repo limits", () => {
  it("passes through in-range limits", async () => {
    const h = harness();
    const result = await build(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: 30, max_install_attempts: 3, disk_mb: 4096 },
    });

    expect(result.content).toMatchObject({
      limits: {
        wall_clock_minutes: 30,
        max_install_attempts: 3,
        disk_mb: 4096,
      },
    });
  });

  it("clamps each limit to its hard cap", async () => {
    const h = harness();
    const result = await build(h).handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 999_999,
      },
    });

    expect(result.content).toMatchObject({
      limits: {
        wall_clock_minutes: 60,
        max_install_attempts: 5,
        disk_mb: 10_000,
      },
    });
  });

  it("floors fractional attempt and disk values", async () => {
    const h = harness();
    const result = await build(h).handler({
      ...GOOD,
      limits: { max_install_attempts: 2.9, disk_mb: 1024.7 },
    });

    expect(result.content).toMatchObject({
      limits: { max_install_attempts: 2, disk_mb: 1024 },
    });
  });

  it("drops non-positive and non-numeric limits rather than passing them down", async () => {
    const h = harness();
    const result = await build(h).handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      },
    });

    expect((result.content as Record<string, unknown>).limits).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a non-object", "20"],
  ])("returns empty limits when limits is %s", async (_label, limits) => {
    const h = harness();
    const result = await build(h).handler({ ...GOOD, limits });

    expect((result.content as Record<string, unknown>).limits).toEqual({});
  });
});

describe("use_repo failure paths", () => {
  it("surfaces dispatch_failed and never inserts the repo_run", async () => {
    const h = harness({ dispatchThrows: new Error("daemon offline") });
    const result = await build(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(h.order).not.toContain("repoRun.create");
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "nope" });
    const result = await build(h).handler(GOOD);

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "nope",
    });
  });

  it("surfaces repo_run_create_failed rather than leaving the agent waiting on an orphan session", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const result = await build(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunThrows: { code: 23505 } });
    const result = await build(h).handler(GOOD);

    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
  });
});
