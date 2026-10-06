/**
 * use_repo tool tests — the Agent App Store's verb (#149).
 *
 * The handler is the only place the ordering contract between
 * `dispatchTask` (creates the session row) and `repoRunRepo.create`
 * (FKs to it) is expressed, and the only place the sandbox `limits`
 * are clamped. Both are covered here with fakes; the live Docker path
 * is exercised by the capability e2e scripts.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRepository, RepoRunRepository, Task, TaskRepository } from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

interface Harness {
  services: UseRepoServices;
  created: Array<Record<string, unknown>>;
  dispatched: Array<Record<string, unknown>>;
  repoRuns: Array<Record<string, unknown>>;
}

function harness(
  overrides: {
    agent?: { id: string } | null;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const created: Array<Record<string, unknown>> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const repoRuns: Array<Record<string, unknown>> = [];
  const agent =
    overrides.agent === undefined ? { id: "agent_caller" } : overrides.agent;

  const agentRepo = {
    findById: vi.fn(async () => agent),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      created.push(row);
      return row as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      if (overrides.repoRunThrows) throw overrides.repoRunThrows;
      repoRuns.push(row);
      return row;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (arg: Record<string, unknown>) => {
      if (overrides.dispatchThrows) throw overrides.dispatchThrows;
      dispatched.push(arg);
      return undefined;
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    created,
    dispatched,
    repoRuns,
  };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: "agent_caller" }, h.services);
}

describe("use_repo tool descriptor", () => {
  it("requires goal + repo_url and rejects unknown properties", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    expect(t.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a blank goal before touching any service", async () => {
    const h = harness();
    const res = await tool(h).handler({ goal: "   ", repo_url: "https://github.com/a/b" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "invalid_goal" });
    expect(h.services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects a missing goal (wrong type counts as missing)", async () => {
    const h = harness();
    const res = await tool(h).handler({ goal: 42, repo_url: "https://github.com/a/b" });

    expect(res.content).toMatchObject({ error: "invalid_goal" });
  });

  it.each([
    ["an empty string", ""],
    ["a non-GitHub host", "https://gitlab.com/a/b"],
    ["http instead of https", "http://github.com/a/b"],
    ["an unparseable url", "not a url"],
    ["a lookalike host suffix", "https://evilgithub.com/a/b"],
    ["a wrong type", 7],
  ])("rejects repo_url: %s", async (_label, repoUrl) => {
    const h = harness();
    const res = await tool(h).handler({ goal: "do a thing", repo_url: repoUrl });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.services.taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/owner/repo",
    "https://www.github.com/owner/repo",
    "https://GitHub.com/owner/repo",
  ])("accepts GitHub HTTPS url %s", async (repoUrl) => {
    const h = harness();
    const res = await tool(h).handler({ goal: "do a thing", repo_url: repoUrl });

    expect(res.isError).toBeFalsy();
    expect(h.repoRuns[0]).toMatchObject({ repo_url: repoUrl });
  });

  it("returns agent_not_found when the caller's agent row is gone", async () => {
    const h = harness({ agent: null });
    const res = await tool(h).handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
    });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "agent_not_found" });
    expect(h.services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const h = harness();
    const res = await tool(h).handler({
      goal: "  Extract the tables from this PDF  ",
      repo_url: "  https://github.com/owner/repo  ",
      input_url: "  https://example.com/in.pdf  ",
      input_filename: "  in.pdf  ",
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Record<string, unknown>;

    // Container task: trimmed goal as both title and description, creator
    // and assignee pinned to the calling agent.
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      title: "Extract the tables from this PDF",
      description: "Extract the tables from this PDF",
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });

    // Dispatch carries the pre-minted session id the repo_run FKs to.
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: "Extract the tables from this PDF",
      reason: { kind: "fresh" },
      sessionIdOverride: content.session_id,
    });

    // repo_run row ties session + task + agent together.
    expect(h.repoRuns).toHaveLength(1);
    expect(h.repoRuns[0]).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_caller",
      goal: "Extract the tables from this PDF",
      repo_url: "https://github.com/owner/repo",
      status: "pending",
    });

    expect(content).toMatchObject({
      status: "pending",
      watch_url: `/capabilities/runs/${String(content.repo_run_id)}`,
      input_url: "https://example.com/in.pdf",
      input_filename: "in.pdf",
    });
    expect(content.note).toContain("Sandbox run started");
  });

  it("dispatches before inserting the repo_run (FK ordering)", async () => {
    const order: string[] = [];
    const h = harness();
    (h.services.dispatchService.dispatchTask as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("dispatch");
      },
    );
    (h.services.repoRunRepo.create as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("repo_run");
        return {};
      },
    );

    await tool(h).handler({ goal: "g", repo_url: "https://github.com/a/b" });

    expect(order).toEqual(["dispatch", "repo_run"]);
  });

  it("truncates an over-long goal for the container task title but not the description", async () => {
    const h = harness();
    const goal = "x".repeat(200);
    await tool(h).handler({ goal, repo_url: "https://github.com/a/b" });

    const title = h.created[0]?.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(h.created[0]?.description).toBe(goal);
  });

  it("collapses internal whitespace in the title and keeps a short goal verbatim", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "two\n\nlines   spaced",
      repo_url: "https://github.com/a/b",
    });

    expect(h.created[0]?.title).toBe("two lines spaced");
  });

  it("omits input_url / input_filename when not supplied", async () => {
    const h = harness();
    const res = await tool(h).handler({ goal: "g", repo_url: "https://github.com/a/b" });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limits clamping", () => {
  it("passes through in-range limits", async () => {
    const h = harness();
    const res = await tool(h).handler({
      goal: "g",
      repo_url: "https://github.com/a/b",
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("caps each limit at its ceiling", async () => {
    const h = harness();
    const res = await tool(h).handler({
      goal: "g",
      repo_url: "https://github.com/a/b",
      limits: { wall_clock_minutes: 999, max_install_attempts: 99, disk_mb: 99_999 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt / disk values", async () => {
    const h = harness();
    const res = await tool(h).handler({
      goal: "g",
      repo_url: "https://github.com/a/b",
      limits: { max_install_attempts: 2.9, disk_mb: 1024.7 },
    });

    expect(res.content.limits).toEqual({ max_install_attempts: 2, disk_mb: 1024 });
  });

  it.each([
    ["zero and negative values", { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: -5 }],
    ["wrong types", { wall_clock_minutes: "20", disk_mb: null }],
    ["a non-object", "nope"],
    ["null", null],
  ])("drops %s, leaving the defaults to the sandbox", async (_label, limits) => {
    const h = harness();
    const res = await tool(h).handler({
      goal: "g",
      repo_url: "https://github.com/a/b",
      limits,
    });

    expect(res.content.limits).toEqual({});
  });
});

describe("use_repo failure surfacing", () => {
  it("returns dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const h = harness({ dispatchThrows: new Error("daemon offline") });
    const res = await tool(h).handler({ goal: "g", repo_url: "https://github.com/a/b" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(h.services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch rejection", async () => {
    const h = harness({ dispatchThrows: "boom" });
    const res = await tool(h).handler({ goal: "g", repo_url: "https://github.com/a/b" });

    expect(res.content).toMatchObject({ error: "dispatch_failed", message: "boom" });
  });

  it("returns repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const h = harness({ repoRunThrows: new Error("fk violation") });
    const res = await tool(h).handler({ goal: "g", repo_url: "https://github.com/a/b" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
  });

  it("stringifies a non-Error repo_run rejection", async () => {
    const h = harness({ repoRunThrows: { code: "23503" } });
    const res = await tool(h).handler({ goal: "g", repo_url: "https://github.com/a/b" });

    expect(res.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(String(res.content.message)).toContain("object");
  });
});
