/**
 * use_repo tool tests — input validation, the ordered write sequence
 * (task → dispatch → repo_run), and the two failure envelopes.
 *
 * The real flow needs Postgres and a daemon to claim the session, so the
 * repositories and DispatchService are faked. What's worth locking here is
 * the handler's own logic: what counts as a GitHub URL, how `limits` are
 * clamped, that the session row is dispatched *before* the repo_run insert
 * (FK ordering the module comments call out), and that a failure at either
 * write step returns a distinguishable error code rather than a bare throw.
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

interface Harness {
  services: UseRepoServices;
  /** Call order across the three collaborators, for FK-ordering assertions. */
  order: string[];
  created: { task?: Record<string, unknown>; repoRun?: Record<string, unknown> };
  dispatched: Array<Record<string, unknown>>;
}

function harness(
  opts: {
    agentMissing?: boolean;
    dispatchThrows?: Error;
    repoRunThrows?: Error;
  } = {},
): Harness {
  const order: string[] = [];
  const created: Harness["created"] = {};
  const dispatched: Array<Record<string, unknown>> = [];

  const agent = opts.agentMissing
    ? undefined
    : ({ id: "agent_caller", name: "Caller" } as unknown as Agent);

  const agentRepo = {
    findById: vi.fn(async () => agent),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("task.create");
      created.task = row;
      return row as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("repoRun.create");
      if (opts.repoRunThrows) throw opts.repoRunThrows;
      created.repoRun = row;
      return row as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      order.push("dispatch");
      if (opts.dispatchThrows) throw opts.dispatchThrows;
      dispatched.push(input);
      return {} as never;
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    order,
    created,
    dispatched,
  };
}

const ctx = { agentId: "agent_caller" };

const validInput = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo descriptor", () => {
  it("requires goal + repo_url and rejects unknown properties", () => {
    const tool = createUseRepoTool(ctx, harness().services);
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing or blank goal before touching any repository", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    for (const goal of [undefined, "", "   ", 42]) {
      const result = await tool.handler({ ...validInput, goal });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(h.order).toEqual([]);
  });

  it.each([
    ["http (not https)", "http://github.com/foo/bar"],
    ["a non-github host", "https://gitlab.com/foo/bar"],
    ["a lookalike host", "https://notgithub.com/foo/bar"],
    ["an unparseable url", "not-a-url"],
    ["an empty string", ""],
    ["git+ssh", "git@github.com:foo/bar.git"],
  ])("rejects %s as repo_url", async (_label, repo_url) => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ ...validInput, repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.order).toEqual([]);
  });

  it.each([
    ["apex github.com", "https://github.com/jsvine/pdfplumber"],
    ["a subdomain", "https://www.github.com/jsvine/pdfplumber"],
    ["mixed case host", "https://GitHub.com/jsvine/pdfplumber"],
  ])("accepts %s", async (_label, repo_url) => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ ...validInput, repo_url });

    expect(result.isError).toBeFalsy();
    expect(h.created.repoRun).toMatchObject({ repo_url });
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const h = harness({ agentMissing: true });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler(validInput);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.order).toEqual([]);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts repo_run — in that order", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler(validInput);

    // repo_run.session_id FKs to session.id, and dispatchTask is what
    // creates the session row — so the insert must come after dispatch.
    expect(h.order).toEqual(["task.create", "dispatch", "repoRun.create"]);
    expect(result.isError).toBeFalsy();

    const content = result.content as Record<string, string>;
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.task_id).toMatch(/^task_/);
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
  });

  it("pins the container task to the resolved agent on both sides", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    await tool.handler(validInput);

    expect(h.created.task).toMatchObject({
      description: validInput.goal,
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });
  });

  it("dispatches under the same pre-minted session id the repo_run points at", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler(validInput);
    const content = result.content as Record<string, string>;

    expect(h.dispatched[0]).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: validInput.goal,
      reason: { kind: "fresh" },
      sessionIdOverride: content.session_id,
    });
    expect(h.created.repoRun).toMatchObject({
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_caller",
      goal: validInput.goal,
      status: "pending",
    });
  });

  it("truncates a long goal into an 80-char task title and collapses whitespace", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);
    const goal = "a".repeat(200);

    await tool.handler({ ...validInput, goal });

    const title = (h.created.task as { title: string }).title;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The untruncated goal still reaches the description in full.
    expect(h.created.task).toMatchObject({ description: goal });
  });

  it("keeps a short goal as the title verbatim, whitespace-normalized", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    await tool.handler({ ...validInput, goal: "  extract\n\ttables  " });

    expect(h.created.task).toMatchObject({ title: "extract tables" });
  });

  it("passes optional input_url / input_filename back trimmed", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      ...validInput,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: " report.pdf ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("omits input_url / input_filename when they are not strings", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ ...validInput, input_url: 7 });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limits parsing", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, number>> {
    const tool = createUseRepoTool(ctx, harness().services);
    const result = await tool.handler({ ...validInput, limits });
    return result.content.limits as Record<string, number>;
  }

  it("passes sane values through untouched", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 512,
      }),
    ).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors the integer-valued limits but not the wall clock", async () => {
    expect(await limitsFor({ max_install_attempts: 2.9, disk_mb: 100.7 })).toEqual({
      max_install_attempts: 2,
      disk_mb: 100,
    });
    expect(await limitsFor({ wall_clock_minutes: 1.5 })).toEqual({
      wall_clock_minutes: 1.5,
    });
  });

  it.each([
    ["a non-object", "20"],
    ["null", null],
    ["an empty object", {}],
    ["zero values", { wall_clock_minutes: 0, max_install_attempts: 0, disk_mb: 0 }],
    ["negative values", { wall_clock_minutes: -5, disk_mb: -1 }],
    ["wrong-typed values", { wall_clock_minutes: "20", disk_mb: true }],
  ])("drops %s to an empty limits object", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });
});

describe("use_repo write failures", () => {
  it("returns dispatch_failed without attempting the repo_run insert", async () => {
    const h = harness({ dispatchThrows: new Error("no runtime online") });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler(validInput);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(h.order).toEqual(["task.create", "dispatch"]);
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "boom" as unknown as Error });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler(validInput);

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler(validInput);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    expect(h.order).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });
});
