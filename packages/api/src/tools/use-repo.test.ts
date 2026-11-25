/**
 * Tests for the `use_repo` MCP tool — the sandboxed "run an external
 * GitHub repo as a one-shot tool" capability.
 *
 * The handler's job is validation plus a three-step write sequence with
 * an order constraint that matters: `repo_run.session_id` has a foreign
 * key to `session.id`, so the dispatch (which creates the session row)
 * has to land *before* the repo_run insert. Both of those steps can
 * fail independently, and each failure gets its own coded error so the
 * calling agent doesn't silently wait on a run that never started.
 *
 * Every collaborator is injected, so this runs against vitest fakes —
 * no database, no Docker, no daemon.
 */
import { describe, it, expect, vi } from "vitest";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";
import type { AgentTool } from "./types.js";

const AGENT = "agt_caller";

interface Fakes {
  findById: ReturnType<typeof vi.fn>;
  taskCreate: ReturnType<typeof vi.fn>;
  repoRunCreate: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
}

function build(): { tool: AgentTool } & Fakes {
  const fakes: Fakes = {
    findById: vi.fn().mockResolvedValue({ id: AGENT, name: "Caller" }),
    taskCreate: vi
      .fn()
      .mockImplementation(async (input: { id: string }) => ({ ...input, status: "todo" })),
    repoRunCreate: vi.fn().mockResolvedValue(undefined),
    dispatchTask: vi.fn().mockResolvedValue({ session: { id: "sess_x" }, runtime_id: null }),
  };
  const services: UseRepoServices = {
    agentRepo: { findById: fakes.findById } as never,
    taskRepo: { create: fakes.taskCreate } as never,
    repoRunRepo: { create: fakes.repoRunCreate } as never,
    dispatchService: { dispatchTask: fakes.dispatchTask } as never,
  };
  return { tool: createUseRepoTool({ agentId: AGENT }, services), ...fakes };
}

const GOAL = "transcribe this video";
const REPO = "https://github.com/openai/whisper";

describe("use_repo tool shape", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { tool } = build();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });

  it("frames itself as the sandbox alternative to host installs", () => {
    const { tool } = build();
    // Agents are told elsewhere not to auto-install; the description has
    // to carry the exemption or they report an install blocker instead.
    expect(tool.description).toContain("brew install");
    expect(tool.description).toContain("find_repo");
  });
});

describe("goal validation", () => {
  it("rejects a missing goal", async () => {
    const { tool, findById } = build();
    const res = await tool.handler({ repo_url: REPO });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only goal", async () => {
    const { tool } = build();
    const res = await tool.handler({ goal: "   \n ", repo_url: REPO });
    expect(res.content.error).toBe("invalid_goal");
  });

  it("rejects a non-string goal", async () => {
    const { tool } = build();
    const res = await tool.handler({ goal: 12, repo_url: REPO });
    expect(res.content.error).toBe("invalid_goal");
  });
});

describe("repo_url validation", () => {
  const rejected: Array<[string, unknown]> = [
    ["a missing url", undefined],
    ["a non-string url", 42],
    ["an empty url", ""],
    ["unparseable text", "not a url at all"],
    ["an http (non-https) github url", "http://github.com/foo/bar"],
    ["an ssh github remote", "git@github.com:foo/bar.git"],
    ["a non-github host", "https://gitlab.com/foo/bar"],
    ["a lookalike host", "https://github.com.evil.example/foo/bar"],
    ["a host merely containing github", "https://notgithub.com/foo/bar"],
  ];

  for (const [label, url] of rejected) {
    it(`rejects ${label}`, async () => {
      const { tool, taskCreate } = build();
      const res = await tool.handler({ goal: GOAL, ...(url === undefined ? {} : { repo_url: url }) });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("invalid_repo_url");
      expect(taskCreate).not.toHaveBeenCalled();
    });
  }

  const accepted: Array<[string, string]> = [
    ["a plain repo url", "https://github.com/foo/bar"],
    ["a .git suffix", "https://github.com/foo/bar.git"],
    ["an uppercase host", "https://GITHUB.COM/foo/bar"],
    ["a www subdomain", "https://www.github.com/foo/bar"],
    ["a deep path", "https://github.com/foo/bar/tree/main/sub"],
  ];

  for (const [label, url] of accepted) {
    it(`accepts ${label}`, async () => {
      const { tool, repoRunCreate } = build();
      const res = await tool.handler({ goal: GOAL, repo_url: url });
      expect(res.isError).toBeUndefined();
      expect(repoRunCreate).toHaveBeenCalledWith(expect.objectContaining({ repo_url: url }));
    });
  }

  it("trims surrounding whitespace off the url", async () => {
    const { tool, repoRunCreate } = build();
    await tool.handler({ goal: GOAL, repo_url: `  ${REPO}  ` });
    expect(repoRunCreate).toHaveBeenCalledWith(expect.objectContaining({ repo_url: REPO }));
  });
});

describe("caller resolution", () => {
  it("errors when the calling agent does not exist", async () => {
    const { tool, findById, taskCreate } = build();
    findById.mockResolvedValue(undefined);
    const res = await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(findById).toHaveBeenCalledWith(AGENT);
    expect(taskCreate).not.toHaveBeenCalled();
  });
});

describe("container task", () => {
  it("pins the task to the calling agent as both creator and assignee", async () => {
    const { tool, taskCreate } = build();
    await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: GOAL,
        description: GOAL,
        priority: "medium",
        assignee_id: AGENT,
        creator_id: AGENT,
        creator_type: "agent",
      }),
    );
    expect(taskCreate.mock.calls[0]?.[0].id).toMatch(/^task_/);
  });

  it("collapses whitespace in the title", async () => {
    const { tool, taskCreate } = build();
    await tool.handler({ goal: "do\n\n  this   thing", repo_url: REPO });
    expect(taskCreate.mock.calls[0]?.[0].title).toBe("do this thing");
  });

  it("ellipsizes a title over 80 characters but keeps the full description", async () => {
    const { tool, taskCreate } = build();
    const goal = "x".repeat(200);
    await tool.handler({ goal, repo_url: REPO });
    const arg = taskCreate.mock.calls[0]?.[0];
    expect(arg.title).toHaveLength(78);
    expect(arg.title.endsWith("…")).toBe(true);
    expect(arg.description).toBe(goal);
  });

  it("leaves an exactly-80-character title alone", async () => {
    const { tool, taskCreate } = build();
    await tool.handler({ goal: "y".repeat(80), repo_url: REPO });
    expect(taskCreate.mock.calls[0]?.[0].title).toBe("y".repeat(80));
  });
});

describe("dispatch + repo_run ordering", () => {
  it("dispatches a run_repo session under a pre-minted id, then inserts the repo_run", async () => {
    const { tool, dispatchTask, repoRunCreate, taskCreate } = build();
    const res = await tool.handler({ goal: GOAL, repo_url: REPO });

    const dispatched = dispatchTask.mock.calls[0]?.[0];
    const taskId = taskCreate.mock.calls[0]?.[0].id;
    expect(dispatched).toMatchObject({
      agentId: AGENT,
      type: "run_repo",
      intent: GOAL,
      reason: { kind: "fresh" },
    });
    expect(dispatched.task.id).toBe(taskId);
    expect(dispatched.sessionIdOverride).toMatch(/^sess_/);

    // The repo_run points at the very session the dispatch created —
    // the FK depends on it, hence the order.
    const run = repoRunCreate.mock.calls[0]?.[0];
    expect(run).toMatchObject({
      session_id: dispatched.sessionIdOverride,
      task_id: taskId,
      agent_id: AGENT,
      goal: GOAL,
      repo_url: REPO,
      status: "pending",
    });
    expect(run.id).toMatch(/^repo_/);
    expect(res.content.session_id).toBe(dispatched.sessionIdOverride);
    expect(res.content.repo_run_id).toBe(run.id);
  });

  it("trims the goal before it reaches the dispatch and the repo_run", async () => {
    const { tool, dispatchTask, repoRunCreate } = build();
    await tool.handler({ goal: `  ${GOAL}  `, repo_url: REPO });
    expect(dispatchTask.mock.calls[0]?.[0].intent).toBe(GOAL);
    expect(repoRunCreate.mock.calls[0]?.[0].goal).toBe(GOAL);
  });

  it("reports dispatch_failed and never inserts a repo_run when dispatch throws", async () => {
    const { tool, dispatchTask, repoRunCreate } = build();
    dispatchTask.mockRejectedValue(new Error("no runtime available"));
    const res = await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime available",
    });
    expect(repoRunCreate).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { tool, dispatchTask } = build();
    dispatchTask.mockRejectedValue("kaboom");
    const res = await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(res.content).toEqual({ error: "dispatch_failed", message: "kaboom" });
  });

  it("reports repo_run_create_failed when the repo_run insert throws", async () => {
    const { tool, repoRunCreate } = build();
    repoRunCreate.mockRejectedValue(new Error("duplicate key"));
    const res = await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { tool, repoRunCreate } = build();
    repoRunCreate.mockRejectedValue({ code: "23505" });
    const res = await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(res.content.error).toBe("repo_run_create_failed");
    expect(res.content.message).toBe("[object Object]");
  });
});

describe("limits parsing", () => {
  async function limitsFor(raw: unknown) {
    const { tool } = build();
    const res = await tool.handler({ goal: GOAL, repo_url: REPO, limits: raw });
    return res.content.limits;
  }

  it("returns an empty object when limits is absent", async () => {
    expect(await limitsFor(undefined)).toEqual({});
  });

  it("returns an empty object for a non-object limits", async () => {
    expect(await limitsFor("30")).toEqual({});
  });

  it("returns an empty object for null", async () => {
    expect(await limitsFor(null)).toEqual({});
  });

  it("passes through in-range values", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 500 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 500 });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors the integral limits but not the wall clock", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 1.5,
        max_install_attempts: 2.9,
        disk_mb: 100.7,
      }),
    ).toEqual({ wall_clock_minutes: 1.5, max_install_attempts: 2, disk_mb: 100 });
  });

  it("drops non-positive values", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: -5 }),
    ).toEqual({});
  });

  it("drops non-numeric values", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: "10", max_install_attempts: null, disk_mb: [1] }),
    ).toEqual({});
  });

  it("keeps the valid keys and drops the invalid ones in one payload", async () => {
    expect(await limitsFor({ wall_clock_minutes: 5, disk_mb: "big" })).toEqual({
      wall_clock_minutes: 5,
    });
  });
});

describe("success envelope", () => {
  it("returns the watch url, pending status and a poll hint", async () => {
    const { tool } = build();
    const res = await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(res.isError).toBeUndefined();
    expect(res.content.status).toBe("pending");
    expect(res.content.watch_url).toBe(`/capabilities/runs/${res.content.repo_run_id}`);
    expect(String(res.content.note)).toMatch(/poll/i);
  });

  it("echoes trimmed input_url and input_filename when given", async () => {
    const { tool } = build();
    const res = await tool.handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: "  https://example.com/clip.mp4 ",
      input_filename: " clip.mp4 ",
    });
    expect(res.content.input_url).toBe("https://example.com/clip.mp4");
    expect(res.content.input_filename).toBe("clip.mp4");
  });

  it("leaves the input fields undefined when they are not strings", async () => {
    const { tool } = build();
    const res = await tool.handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: 5,
      input_filename: null,
    });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });

  it("mints a distinct repo_run id and session id per call", async () => {
    const { tool } = build();
    const a = await tool.handler({ goal: GOAL, repo_url: REPO });
    const b = await tool.handler({ goal: GOAL, repo_url: REPO });
    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
    expect(a.content.task_id).not.toBe(b.content.task_id);
  });
});
