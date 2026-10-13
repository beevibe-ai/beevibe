/**
 * use_repo tool tests — validation, the ordered create sequence, and the
 * two failure seams that leave rows behind.
 *
 * The real flow needs Postgres and a daemon to claim the dispatch, but
 * everything the tool itself decides (what counts as a GitHub URL, how
 * limits are clamped, what order the three rows are created in, and what
 * the agent is told when a step fails) is pure and belongs here.
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

interface Harness {
  services: UseRepoServices;
  /** Names of the service calls that ran, in order. */
  order: string[];
  created: { task?: Record<string, unknown>; repoRun?: Record<string, unknown> };
  dispatched: Record<string, unknown>[];
}

function harness(
  opts: {
    agent?: { id: string } | null;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const order: string[] = [];
  const created: Harness["created"] = {};
  const dispatched: Record<string, unknown>[] = [];
  const agent = opts.agent === undefined ? { id: "agent_caller" } : opts.agent;

  const agentRepo = {
    findById: vi.fn(async () => {
      order.push("agentRepo.findById");
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("taskRepo.create");
      created.task = row;
      return row as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("repoRunRepo.create");
      if (opts.repoRunThrows) throw opts.repoRunThrows;
      created.repoRun = row;
      return row;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (args: Record<string, unknown>) => {
      order.push("dispatchService.dispatchTask");
      if (opts.dispatchThrows) throw opts.dispatchThrows;
      dispatched.push(args);
      return undefined;
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    order,
    created,
    dispatched,
  };
}

function tool(h: Harness, agentId = "agent_caller") {
  return createUseRepoTool({ agentId }, h.services);
}

const GOOD = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    // additionalProperties:false matters — a typo'd arg should be rejected
    // by the MCP client rather than silently dropped here.
    expect(t.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing goal before touching any service", async () => {
    const h = harness();
    const res = await tool(h).handler({ repo_url: GOOD.repo_url });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "invalid_goal" });
    expect(h.order).toEqual([]);
  });

  it("rejects a whitespace-only goal", async () => {
    const h = harness();
    const res = await tool(h).handler({ goal: "   \n ", repo_url: GOOD.repo_url });
    expect(res.content).toMatchObject({ error: "invalid_goal" });
    expect(h.order).toEqual([]);
  });

  it("rejects a non-string goal", async () => {
    const h = harness();
    const res = await tool(h).handler({ goal: 42, repo_url: GOOD.repo_url });
    expect(res.content).toMatchObject({ error: "invalid_goal" });
  });

  it.each([
    ["missing", undefined],
    ["non-string", 7],
    ["empty", ""],
    ["http, not https", "http://github.com/foo/bar"],
    ["a non-GitHub host", "https://gitlab.com/foo/bar"],
    ["a lookalike host", "https://github.com.evil.test/foo/bar"],
    ["unparseable", "not a url at all"],
    ["an ssh remote", "git@github.com:foo/bar.git"],
  ])("rejects repo_url that is %s", async (_label, repoUrl) => {
    const h = harness();
    const res = await tool(h).handler({ goal: GOOD.goal, repo_url: repoUrl });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.order).toEqual([]);
  });

  it.each([
    "https://github.com/jsvine/pdfplumber",
    "https://www.github.com/jsvine/pdfplumber",
    "https://GitHub.com/jsvine/pdfplumber",
    "https://github.com/jsvine/pdfplumber.git",
  ])("accepts %s", async (repoUrl) => {
    const h = harness();
    const res = await tool(h).handler({ goal: GOOD.goal, repo_url: repoUrl });
    expect(res.isError).toBeFalsy();
  });

  it("trims goal and repo_url before use", async () => {
    const h = harness();
    const res = await tool(h).handler({
      goal: "  tidy me  ",
      repo_url: `  ${GOOD.repo_url}  `,
    });
    expect(res.isError).toBeFalsy();
    expect(h.created.task).toMatchObject({ title: "tidy me", description: "tidy me" });
    expect(h.created.repoRun).toMatchObject({
      goal: "tidy me",
      repo_url: GOOD.repo_url,
    });
  });
});

describe("use_repo caller resolution", () => {
  it("fails with agent_not_found when the token's agent is gone", async () => {
    const h = harness({ agent: null });
    const res = await tool(h).handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "agent_not_found" });
    // Looked the agent up, then stopped — no task row for a ghost caller.
    expect(h.order).toEqual(["agentRepo.findById"]);
  });

  it("looks the caller up by the context agentId", async () => {
    const h = harness();
    await tool(h, "agent_zed").handler(GOOD);
    expect(h.services.agentRepo.findById).toHaveBeenCalledWith("agent_zed");
  });

  it("pins the container task's assignee and creator to the resolved agent", async () => {
    const h = harness();
    await tool(h).handler(GOOD);
    expect(h.created.task).toMatchObject({
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
      priority: "medium",
    });
  });
});

describe("use_repo container task title", () => {
  it("collapses whitespace in the title but keeps the goal verbatim as description", async () => {
    const h = harness();
    const goal = "extract\n\ttables   from\nthe PDF";
    await tool(h).handler({ ...GOOD, goal });
    expect(h.created.task?.title).toBe("extract tables from the PDF");
    expect(h.created.task?.description).toBe(goal.trim());
  });

  it("leaves an 80-char title untouched", async () => {
    const h = harness();
    const goal = "g".repeat(80);
    await tool(h).handler({ ...GOOD, goal });
    expect(h.created.task?.title).toBe(goal);
  });

  it("truncates an over-80-char title to 77 chars plus an ellipsis", async () => {
    const h = harness();
    await tool(h).handler({ ...GOOD, goal: "g".repeat(200) });
    const title = h.created.task?.title as string;
    expect(title).toBe("g".repeat(77) + "…");
    expect(title).toHaveLength(78);
  });
});

describe("use_repo create ordering", () => {
  // repo_run.session_id has a FK to session.id, so the dispatch (which
  // creates the session row) has to land before the repo_run insert.
  it("dispatches before inserting repo_run", async () => {
    const h = harness();
    await tool(h).handler(GOOD);
    expect(h.order).toEqual([
      "agentRepo.findById",
      "taskRepo.create",
      "dispatchService.dispatchTask",
      "repoRunRepo.create",
    ]);
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);
    const dispatch = h.dispatched[0];
    expect(dispatch).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
    });
    // Same id the agent is handed back, and the one repo_run points at.
    expect(dispatch?.sessionIdOverride).toBe(res.content.session_id);
    expect(h.created.repoRun?.session_id).toBe(res.content.session_id);
    expect(dispatch?.task).toBe(h.created.task);
  });

  it("ties repo_run to the container task and the caller, pending", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);
    expect(h.created.repoRun).toMatchObject({
      id: res.content.repo_run_id,
      task_id: h.created.task?.id,
      agent_id: "agent_caller",
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  it("mints prefixed ids for the task, session and repo_run", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);
    expect(res.content.task_id).toMatch(/^task_/);
    expect(res.content.session_id).toMatch(/^sess_/);
    expect(res.content.repo_run_id).toMatch(/^repo_/);
  });

  it("mints fresh ids per call", async () => {
    const h = harness();
    const a = await tool(h).handler(GOOD);
    const b = await tool(h).handler(GOOD);
    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
  });
});

describe("use_repo failure seams", () => {
  it("reports dispatch_failed and never inserts repo_run", async () => {
    const h = harness({ dispatchThrows: new Error("daemon offline") });
    const res = await tool(h).handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(h.order).not.toContain("repoRunRepo.create");
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "boom" });
    const res = await tool(h).handler(GOOD);
    expect(res.content).toMatchObject({ error: "dispatch_failed", message: "boom" });
  });

  it("surfaces repo_run_create_failed rather than silently orphaning the session", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const res = await tool(h).handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunThrows: { code: 23505 } });
    const res = await tool(h).handler(GOOD);
    expect(res.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof res.content.message).toBe("string");
  });
});

describe("use_repo limits", () => {
  it("omits limits entirely when none are passed", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);
    expect(res.content.limits).toEqual({});
  });

  it.each([null, "20", 20, []])("treats %p as no limits", async (limits) => {
    const h = harness();
    const res = await tool(h).handler({ ...GOOD, limits });
    // An array is an object, so it parses to {} by having no numeric keys.
    expect(res.content.limits).toEqual({});
  });

  it("passes through in-range limits", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: 600, max_install_attempts: 99, disk_mb: 1e9 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk limits but not wall clock", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: 1.5, max_install_attempts: 2.9, disk_mb: 100.7 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 1.5,
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it.each([0, -5])("drops a non-positive limit (%p)", async (bad) => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: bad, max_install_attempts: bad, disk_mb: bad },
    });
    expect(res.content.limits).toEqual({});
  });

  it("drops non-numeric limit values", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: "20", max_install_attempts: null, disk_mb: 256 },
    });
    expect(res.content.limits).toEqual({ disk_mb: 256 });
  });
});

describe("use_repo success envelope", () => {
  it("returns the ids, a watch url and the polling note", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);
    expect(res.isError).toBeFalsy();
    expect(res.content.status).toBe("pending");
    expect(res.content.watch_url).toBe(
      `/capabilities/runs/${res.content.repo_run_id}`,
    );
    expect(String(res.content.note)).toContain("repo_run.status");
  });

  it("echoes trimmed input_url and input_filename", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(res.content.input_url).toBe("https://example.test/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("leaves input fields undefined when they are absent or not strings", async () => {
    const h = harness();
    const res = await tool(h).handler({ ...GOOD, input_url: 5 });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});
