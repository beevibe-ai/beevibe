/**
 * use_repo MCP tool tests.
 *
 * The handler is the api-side half of the Capability Network: validate
 * the agent's untyped input, clamp the requested sandbox limits, create
 * the container task, then dispatch and record the repo_run in that
 * order (repo_run.session_id has an FK to session.id). These tests fake
 * every repo and the dispatch service, so they pin the ordering and the
 * error envelopes without a database or a Docker sandbox.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool } from "./use-repo.js";
import type { AgentTool } from "./types.js";

const AGENT = {
  id: "agent_caller",
  name: "Agent",
  owner_id: "person_owner",
  hierarchy_level: "ic" as const,
  runtime_config: { type: "claude" as const },
  created_at: new Date(),
  updated_at: new Date(),
};

let agentRepo: AgentRepository;
let taskRepo: TaskRepository;
let repoRunRepo: RepoRunRepository;
let dispatchService: DispatchService;
let calls: string[];

beforeEach(() => {
  calls = [];
  agentRepo = {
    findById: vi.fn().mockResolvedValue(AGENT),
  } as unknown as AgentRepository;
  taskRepo = {
    create: vi.fn().mockImplementation(async (input: { id: string; title: string }) => {
      calls.push("task.create");
      return { ...input, status: "assigned", created_at: new Date(), updated_at: new Date() };
    }),
  } as unknown as TaskRepository;
  repoRunRepo = {
    create: vi.fn().mockImplementation(async () => {
      calls.push("repoRun.create");
    }),
  } as unknown as RepoRunRepository;
  dispatchService = {
    dispatchTask: vi.fn().mockImplementation(async () => {
      calls.push("dispatch");
      return { session: { id: "sess_x" }, runtime_id: null };
    }),
  } as unknown as DispatchService;
});

function build(): AgentTool {
  return createUseRepoTool(
    { agentId: "agent_caller" },
    { agentRepo, taskRepo, repoRunRepo, dispatchService },
  );
}

const GOOD = { goal: "Extract the tables", repo_url: "https://github.com/acme/tool" };

describe("use_repo tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const tool = build();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });

  it("tells the agent it is the sandboxed alternative to a host install", () => {
    // The description is the agent-facing contract: it has to say that a
    // sandboxed install is not a system install, or agents report an
    // install blocker instead of calling this.
    expect(build().description).toMatch(/NOT system installs/);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing goal", async () => {
    const out = await build().handler({ repo_url: GOOD.repo_url });
    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("invalid_goal");
    expect(taskRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only goal", async () => {
    const out = await build().handler({ goal: "   ", repo_url: GOOD.repo_url });
    expect(out.content.error).toBe("invalid_goal");
  });

  it("rejects a non-string goal", async () => {
    const out = await build().handler({ goal: 42, repo_url: GOOD.repo_url });
    expect(out.content.error).toBe("invalid_goal");
  });

  it("rejects a missing repo_url", async () => {
    const out = await build().handler({ goal: GOOD.goal });
    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("invalid_repo_url");
  });

  it.each([
    ["http (not https)", "http://github.com/acme/tool"],
    ["a non-GitHub host", "https://gitlab.com/acme/tool"],
    ["a lookalike host", "https://github.com.evil.test/acme/tool"],
    ["a bare word", "acme/tool"],
    ["an ssh remote", "git@github.com:acme/tool.git"],
    ["an empty string", ""],
  ])("rejects %s", async (_label, repo_url) => {
    const out = await build().handler({ goal: GOOD.goal, repo_url });
    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("invalid_repo_url");
    expect(taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["the canonical form", "https://github.com/acme/tool"],
    ["a www subdomain", "https://www.github.com/acme/tool"],
    ["mixed case host", "https://GitHub.com/acme/tool"],
    ["a deep path", "https://github.com/acme/tool/tree/main/sub"],
  ])("accepts %s", async (_label, repo_url) => {
    const out = await build().handler({ goal: GOOD.goal, repo_url });
    expect(out.isError).toBeUndefined();
    expect(out.content.status).toBe("pending");
  });

  it("trims the goal and repo_url before using them", async () => {
    await build().handler({
      goal: "  Extract the tables  ",
      repo_url: "  https://github.com/acme/tool  ",
    });
    expect(vi.mocked(taskRepo.create).mock.calls[0]![0]).toMatchObject({
      description: "Extract the tables",
    });
    expect(vi.mocked(repoRunRepo.create).mock.calls[0]![0]).toMatchObject({
      repo_url: "https://github.com/acme/tool",
      goal: "Extract the tables",
    });
  });
});

describe("use_repo container task", () => {
  it("titles the task from the goal and collapses whitespace", async () => {
    await build().handler({ ...GOOD, goal: "Extract   the\n\ntables" });
    expect(vi.mocked(taskRepo.create).mock.calls[0]![0]).toMatchObject({
      title: "Extract the tables",
    });
  });

  it("truncates a long title to 80 chars with an ellipsis, keeping the full goal as description", async () => {
    const goal = "x".repeat(200);
    await build().handler({ ...GOOD, goal });
    const created = vi.mocked(taskRepo.create).mock.calls[0]![0] as {
      title: string;
      description: string;
    };
    expect(created.title).toHaveLength(78); // 77 chars + the 1-char ellipsis
    expect(created.title.endsWith("…")).toBe(true);
    expect(created.description).toBe(goal);
  });

  it("leaves an exactly-80-char title alone", async () => {
    const goal = "y".repeat(80);
    await build().handler({ ...GOOD, goal });
    const created = vi.mocked(taskRepo.create).mock.calls[0]![0] as { title: string };
    expect(created.title).toBe(goal);
  });

  it("pins creator and assignee to the calling agent", async () => {
    await build().handler(GOOD);
    expect(vi.mocked(taskRepo.create).mock.calls[0]![0]).toMatchObject({
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
      priority: "medium",
    });
  });

  it("errors when the calling agent no longer exists", async () => {
    vi.mocked(agentRepo.findById).mockResolvedValue(undefined);
    const out = await build().handler(GOOD);
    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("agent_not_found");
    expect(taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo limits clamping", () => {
  it("returns {} when limits are absent", async () => {
    const out = await build().handler(GOOD);
    expect(out.content.limits).toEqual({});
  });

  it.each([[null], [undefined], ["big"], [42], [true]])(
    "returns {} for a non-object limits value (%s)",
    async (limits) => {
      const out = await build().handler({ ...GOOD, limits });
      expect(out.content.limits).toEqual({});
    },
  );

  it("passes sane limits through untouched", async () => {
    const out = await build().handler({
      ...GOOD,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 500 },
    });
    expect(out.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 500,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const out = await build().handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      },
    });
    expect(out.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    const out = await build().handler({
      ...GOOD,
      limits: { max_install_attempts: 2.9, disk_mb: 100.7 },
    });
    expect(out.content.limits).toEqual({ max_install_attempts: 2, disk_mb: 100 });
  });

  it("drops non-positive and non-numeric limit fields", async () => {
    const out = await build().handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "500",
      },
    });
    expect(out.content.limits).toEqual({});
  });

  it("keeps the valid fields when only some are bad", async () => {
    const out = await build().handler({
      ...GOOD,
      limits: { wall_clock_minutes: 5, disk_mb: -3 },
    });
    expect(out.content.limits).toEqual({ wall_clock_minutes: 5 });
  });
});

describe("use_repo input file passthrough", () => {
  it("trims and echoes input_url and input_filename", async () => {
    const out = await build().handler({
      ...GOOD,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(out.content.input_url).toBe("https://example.test/a.pdf");
    expect(out.content.input_filename).toBe("a.pdf");
  });

  it("omits them when not strings", async () => {
    const out = await build().handler({ ...GOOD, input_url: 1, input_filename: {} });
    expect(out.content.input_url).toBeUndefined();
    expect(out.content.input_filename).toBeUndefined();
  });
});

describe("use_repo dispatch ordering and failures", () => {
  it("creates the task, dispatches, then inserts the repo_run in that order", async () => {
    await build().handler(GOOD);
    expect(calls).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const out = await build().handler(GOOD);
    const dispatched = vi.mocked(dispatchService.dispatchTask).mock.calls[0]![0] as {
      agentId: string;
      type: string;
      intent: string;
      sessionIdOverride: string;
      reason: { kind: string };
    };
    expect(dispatched).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
    });
    // The same id has to reach the repo_run row, or the FK dangles.
    expect(dispatched.sessionIdOverride).toBe(out.content.session_id);
    expect(vi.mocked(repoRunRepo.create).mock.calls[0]![0]).toMatchObject({
      session_id: out.content.session_id,
      status: "pending",
    });
  });

  it("returns the ids and a watch url the UI can follow", async () => {
    const out = await build().handler(GOOD);
    expect(out.content.status).toBe("pending");
    expect(out.content.repo_run_id).toEqual(expect.any(String));
    expect(out.content.session_id).toEqual(expect.any(String));
    expect(out.content.task_id).toEqual(expect.any(String));
    expect(out.content.watch_url).toBe(
      `/capabilities/runs/${out.content.repo_run_id as string}`,
    );
    expect(out.content.note).toMatch(/poll/i);
  });

  it("mints a fresh repo_run and session id per call", async () => {
    const tool = build();
    const a = await tool.handler(GOOD);
    const b = await tool.handler(GOOD);
    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
  });

  it("reports dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    vi.mocked(dispatchService.dispatchTask).mockRejectedValue(new Error("no runtime"));
    const out = await build().handler(GOOD);
    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime",
    });
    expect(repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    vi.mocked(dispatchService.dispatchTask).mockRejectedValue("nope");
    const out = await build().handler(GOOD);
    expect(out.content).toMatchObject({ error: "dispatch_failed", message: "nope" });
  });

  it("reports repo_run_create_failed when the repo_run insert throws", async () => {
    vi.mocked(repoRunRepo.create).mockRejectedValue(new Error("fk violation"));
    const out = await build().handler(GOOD);
    expect(out.isError).toBe(true);
    expect(out.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    vi.mocked(repoRunRepo.create).mockRejectedValue({ code: "23503" });
    const out = await build().handler(GOOD);
    expect(out.content.error).toBe("repo_run_create_failed");
    expect(out.content.message).toBe("[object Object]");
  });
});
