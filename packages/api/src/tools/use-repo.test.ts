/**
 * `use_repo` handler tests — the Capability Network's write path.
 *
 * The tool was untested end to end even though it mints three rows in a
 * fixed order (task → session → repo_run) and each ordering failure has
 * its own documented recovery. What matters and is asserted here: the
 * repo_url gate (it decides whether arbitrary URLs reach a sandbox), the
 * limit clamps (they cap wall-clock, retries and disk), that the
 * repo_run insert carries the same pre-minted session id the dispatch
 * used, and that a partial failure reports rather than silently leaving
 * the agent to wait on a run that will never start.
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

const AGENT = "agent_caller";

function fakeAgent(): Agent {
  return {
    id: AGENT,
    name: "Caller",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  } as Agent;
}

function harness() {
  const agentRepo = {
    findById: vi.fn().mockResolvedValue(fakeAgent()),
  } as unknown as AgentRepository;
  const taskRepo = {
    create: vi.fn(async (input: { id: string }) => ({ ...input }) as unknown as Task),
  } as unknown as TaskRepository;
  const repoRunRepo = { create: vi.fn().mockResolvedValue({}) } as unknown as RepoRunRepository;
  const dispatchService = {
    dispatchTask: vi.fn().mockResolvedValue({ session: {}, runtime_id: null }),
  } as unknown as DispatchService;

  const services: UseRepoServices = { agentRepo, taskRepo, repoRunRepo, dispatchService };
  const tool = createUseRepoTool({ agentId: AGENT }, services);
  return { agentRepo, taskRepo, repoRunRepo, dispatchService, tool };
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

// ── argument validation ──────────────────────────────────────────────────

describe("use_repo — input validation", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["not a string", 42],
  ])("rejects a %s goal before creating anything", async (_label, goal) => {
    const h = harness();
    const res = await h.tool.handler({ ...OK_INPUT, goal });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(h.taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-GitHub host", "https://gitlab.com/foo/bar"],
    ["plain http", "http://github.com/foo/bar"],
    ["an ssh remote", "git@github.com:foo/bar.git"],
    ["a lookalike host", "https://github.com.evil.example/foo/bar"],
    ["unparseable junk", "not a url"],
    ["an empty string", ""],
  ])("rejects %s as repo_url", async (_label, repo_url) => {
    const h = harness();
    const res = await h.tool.handler({ ...OK_INPUT, repo_url });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["the apex host", "https://github.com/foo/bar"],
    ["a subdomain", "https://raw.github.com/foo/bar"],
    ["mixed case", "https://GitHub.COM/foo/bar"],
  ])("accepts %s", async (_label, repo_url) => {
    const h = harness();
    const res = await h.tool.handler({ ...OK_INPUT, repo_url });
    expect(res.isError).toBeUndefined();
  });

  it("404s when the calling agent row is gone", async () => {
    const h = harness();
    vi.mocked(h.agentRepo.findById).mockResolvedValue(undefined);
    const res = await h.tool.handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(h.taskRepo.create).not.toHaveBeenCalled();
  });
});

// ── happy path ───────────────────────────────────────────────────────────

describe("use_repo — run creation", () => {
  it("creates task, session and repo_run and returns the watch handles", async () => {
    const h = harness();
    const res = await h.tool.handler({ ...OK_INPUT, input_url: " https://x/y.pdf " });

    expect(res.isError).toBeUndefined();
    const content = res.content as Record<string, string>;
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.task_id).toMatch(/^task_/);
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    // Trimmed on the way through.
    expect(content.input_url).toBe("https://x/y.pdf");
  });

  it("pins the repo_run to the session id the dispatch was given", async () => {
    const h = harness();
    const res = await h.tool.handler(OK_INPUT);

    const dispatched = vi.mocked(h.dispatchService.dispatchTask).mock.calls[0]?.[0];
    const inserted = vi.mocked(h.repoRunRepo.create).mock.calls[0]?.[0];
    expect(dispatched?.sessionIdOverride).toBe(inserted?.session_id);
    expect(inserted?.session_id).toBe(res.content.session_id);
    expect(inserted).toMatchObject({
      agent_id: AGENT,
      goal: OK_INPUT.goal,
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });
  });

  it("dispatches a run_repo session carrying the container task", async () => {
    const h = harness();
    await h.tool.handler(OK_INPUT);

    const created = vi.mocked(h.taskRepo.create).mock.calls[0]?.[0];
    expect(created).toMatchObject({
      description: OK_INPUT.goal,
      priority: "medium",
      assignee_id: AGENT,
      creator_id: AGENT,
      creator_type: "agent",
    });
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        type: "run_repo",
        intent: OK_INPUT.goal,
        reason: { kind: "fresh" },
      }),
    );
  });

  it("cuts a long goal down to an 80-char container-task title", async () => {
    const h = harness();
    await h.tool.handler({ ...OK_INPUT, goal: "z".repeat(200) });
    const title = vi.mocked(h.taskRepo.create).mock.calls[0]?.[0].title as string;
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
  });

  it("collapses whitespace in the title but keeps the full goal as description", async () => {
    const h = harness();
    await h.tool.handler({ ...OK_INPUT, goal: "  do\n\n  the   thing  " });
    const created = vi.mocked(h.taskRepo.create).mock.calls[0]?.[0];
    expect(created?.title).toBe("do the thing");
    expect(created?.description).toBe("do\n\n  the   thing");
  });
});

// ── limits ───────────────────────────────────────────────────────────────

describe("use_repo — limits", () => {
  it("echoes limits within range untouched", async () => {
    const h = harness();
    const res = await h.tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 5, max_install_attempts: 3, disk_mb: 512 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 5,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const h = harness();
    const res = await h.tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 600, max_install_attempts: 99, disk_mb: 1_000_000 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional counts", async () => {
    const h = harness();
    const res = await h.tool.handler({
      ...OK_INPUT,
      limits: { max_install_attempts: 2.9, disk_mb: 100.7 },
    });
    expect(res.content.limits).toEqual({ max_install_attempts: 2, disk_mb: 100 });
  });

  it.each([
    ["absent", undefined],
    ["not an object", "20"],
    ["null", null],
    ["zero / negative / non-numeric values", { wall_clock_minutes: 0, disk_mb: -1 }],
  ])("drops %s limits to an empty object", async (_label, limits) => {
    const h = harness();
    const res = await h.tool.handler({ ...OK_INPUT, limits });
    expect(res.content.limits).toEqual({});
  });
});

// ── partial failure ──────────────────────────────────────────────────────

describe("use_repo — failure reporting", () => {
  it("reports dispatch_failed without attempting the repo_run insert", async () => {
    const h = harness();
    vi.mocked(h.dispatchService.dispatchTask).mockRejectedValue(
      new Error("DispatchService: agent not found"),
    );

    const res = await h.tool.handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "DispatchService: agent not found",
    });
    expect(h.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("reports repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const h = harness();
    vi.mocked(h.repoRunRepo.create).mockRejectedValue(
      new Error('duplicate key value violates unique constraint "repo_run_pkey"'),
    );

    const res = await h.tool.handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("repo_run_create_failed");
    expect(String(res.content.message)).toContain("duplicate key");
  });

  it("stringifies a non-Error throw rather than losing it", async () => {
    const h = harness();
    vi.mocked(h.dispatchService.dispatchTask).mockRejectedValue("pool is draining");
    const res = await h.tool.handler(OK_INPUT);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "pool is draining",
    });
  });
});
