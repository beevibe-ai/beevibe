/**
 * `use_repo` tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * This tool spends real money (a sandboxed child agent) and writes three
 * coupled rows, so the branches that matter are the guards in front of
 * the spend and the ordering the FK depends on:
 *   - `isLikelyGithubUrl` is the only thing stopping an agent from
 *     handing an arbitrary URL to a container that clones it;
 *   - `repo_run.session_id` FKs to `session.id`, so dispatch must happen
 *     before the repo_run insert — and each failure has to surface a
 *     distinct error rather than leaving the agent waiting on a run
 *     that will never start;
 *   - `parseLimits` clamps caller-supplied resource limits; an unclamped
 *     `wall_clock_minutes` is a container that runs all day.
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
import { createUseRepoTool } from "./use-repo.js";

const AGENT = "agent_a";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return { id: AGENT, name: "Ada", hierarchy_level: "ic", ...overrides } as unknown as Agent;
}

function harness(
  opts: {
    agent?: Agent | undefined;
    dispatchError?: Error;
    repoRunError?: Error;
  } = {},
) {
  const agentRepo = {
    findById: vi.fn().mockResolvedValue("agent" in opts ? opts.agent : fakeAgent()),
  };
  const taskRepo = {
    create: vi.fn(async (input: { id: string; title: string }) => input as unknown as Task),
  };
  const repoRunRepo = {
    create: opts.repoRunError
      ? vi.fn().mockRejectedValue(opts.repoRunError)
      : vi.fn(async (input: unknown) => input),
  };
  const dispatchService = {
    dispatchTask: opts.dispatchError
      ? vi.fn().mockRejectedValue(opts.dispatchError)
      : vi.fn().mockResolvedValue({ session: { id: "ignored" }, runtime_id: null }),
  };

  const tool = createUseRepoTool(
    { agentId: AGENT },
    {
      agentRepo: agentRepo as unknown as AgentRepository,
      taskRepo: taskRepo as unknown as TaskRepository,
      repoRunRepo: repoRunRepo as unknown as RepoRunRepository,
      dispatchService: dispatchService as unknown as DispatchService,
    },
  );

  return { tool, agentRepo, taskRepo, repoRunRepo, dispatchService };
}

const OK_URL = "https://github.com/yt-dlp/yt-dlp";

describe("use_repo tool shape", () => {
  it("exposes the name and a schema the MCP server can advertise", () => {
    const { tool } = harness();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema).toBeTypeOf("object");
    expect(tool.description).toContain("use_repo");
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing, empty, or whitespace-only goal before spending anything", async () => {
    const { tool, dispatchService, taskRepo } = harness();
    for (const goal of [undefined, "", "   ", 42]) {
      const res = await tool.handler({ goal, repo_url: OK_URL });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(taskRepo.create).not.toHaveBeenCalled();
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("rejects a non-GitHub or malformed repo_url", async () => {
    const { tool, dispatchService } = harness();
    const bad = [
      undefined,
      "",
      "not a url",
      // Right host, wrong scheme — no plaintext clone.
      "http://github.com/a/b",
      "git@github.com:a/b.git",
      "https://gitlab.com/a/b",
      // Lookalike hosts must not pass the suffix check.
      "https://github.com.evil.test/a/b",
      "https://notgithub.com/a/b",
      "https://evilgithub.com/a/b",
    ];
    for (const repo_url of bad) {
      const res = await tool.handler({ goal: "download a video", repo_url });
      expect(res.isError, `expected ${String(repo_url)} to be rejected`).toBe(true);
      expect(res.content).toMatchObject({ error: "invalid_repo_url" });
    }
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("accepts github.com and its subdomains", async () => {
    for (const repo_url of [
      "https://github.com/yt-dlp/yt-dlp",
      "https://www.github.com/yt-dlp/yt-dlp",
      // Case-insensitive host match.
      "https://GitHub.com/yt-dlp/yt-dlp",
    ]) {
      const { tool } = harness();
      const res = await tool.handler({ goal: "download a video", repo_url });
      expect(res.isError, `expected ${repo_url} to be accepted`).toBeUndefined();
    }
  });

  it("trims surrounding whitespace off the goal and url", async () => {
    const { tool, taskRepo, dispatchService } = harness();
    const res = await tool.handler({ goal: "  grab audio  ", repo_url: `  ${OK_URL}  ` });
    expect(res.isError).toBeUndefined();
    expect(taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "grab audio", description: "grab audio" }),
    );
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "grab audio" }),
    );
  });

  it("errors when the calling agent no longer exists", async () => {
    const { tool, taskRepo } = harness({ agent: undefined });
    const res = await tool.handler({ goal: "grab audio", repo_url: OK_URL });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "agent_not_found" });
    expect(taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo container task", () => {
  it("pins the container task to the calling agent as both creator and assignee", async () => {
    const { tool, taskRepo } = harness();
    await tool.handler({ goal: "grab audio", repo_url: OK_URL });
    expect(taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee_id: AGENT,
        creator_id: AGENT,
        creator_type: "agent",
        priority: "medium",
      }),
    );
  });

  it("collapses whitespace in the title so the inbox row stays scannable", async () => {
    const { tool, taskRepo } = harness();
    await tool.handler({ goal: "grab\n\n  the   audio", repo_url: OK_URL });
    expect(taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "grab the audio" }),
    );
  });

  it("truncates a long title to 80 chars with an ellipsis, keeping the full goal as description", async () => {
    const { tool, taskRepo } = harness();
    const goal = "x".repeat(200);
    await tool.handler({ goal, repo_url: OK_URL });
    const arg = taskRepo.create.mock.calls[0]![0] as unknown as {
      title: string;
      description: string;
    };
    expect(arg.title).toHaveLength(78);
    expect(arg.title.endsWith("…")).toBe(true);
    expect(arg.description).toBe(goal);
  });

  it("leaves a title exactly at the 80-char boundary unabridged", async () => {
    const { tool, taskRepo } = harness();
    const goal = "y".repeat(80);
    await tool.handler({ goal, repo_url: OK_URL });
    const arg = taskRepo.create.mock.calls[0]![0] as unknown as { title: string };
    expect(arg.title).toBe(goal);
  });
});

describe("use_repo dispatch ordering", () => {
  it("dispatches with a pre-minted session id, then inserts repo_run against it", async () => {
    const { tool, dispatchService, repoRunRepo } = harness();
    const res = await tool.handler({ goal: "grab audio", repo_url: OK_URL });

    const dispatched = dispatchService.dispatchTask.mock.calls[0]![0] as {
      sessionIdOverride: string;
      type: string;
      reason: unknown;
    };
    const run = repoRunRepo.create.mock.calls[0]![0] as {
      session_id: string;
      repo_url: string;
      status: string;
      agent_id: string;
    };

    expect(dispatched.type).toBe("run_repo");
    expect(dispatched.reason).toEqual({ kind: "fresh" });
    // The FK: repo_run.session_id must be the id dispatch created.
    expect(run.session_id).toBe(dispatched.sessionIdOverride);
    expect(run.repo_url).toBe(OK_URL);
    expect(run.status).toBe("pending");
    expect(run.agent_id).toBe(AGENT);
    expect(res.content).toMatchObject({
      session_id: dispatched.sessionIdOverride,
      status: "pending",
    });
  });

  it("returns the ids and a watch_url pointing at the new run", async () => {
    const { tool } = harness();
    const res = await tool.handler({ goal: "grab audio", repo_url: OK_URL });
    const c = res.content as Record<string, string>;
    expect(c.repo_run_id).toMatch(/^repo_/);
    expect(c.watch_url).toBe(`/capabilities/runs/${c.repo_run_id}`);
    expect(c.task_id).toBeTruthy();
    expect(c.note).toContain("poll");
  });

  it("surfaces dispatch_failed and skips the repo_run insert", async () => {
    const { tool, repoRunRepo } = harness({ dispatchError: new Error("no runtime bound") });
    const res = await tool.handler({ goal: "grab audio", repo_url: OK_URL });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime bound",
    });
    // No orphan repo_run pointing at a session that was never created.
    expect(repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on a run that won't compose", async () => {
    const { tool } = harness({ repoRunError: new Error("duplicate key") });
    const res = await tool.handler({ goal: "grab audio", repo_url: OK_URL });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error throw rather than reporting [object Object]", async () => {
    const { tool } = harness({ dispatchError: "pg exploded" as unknown as Error });
    const res = await tool.handler({ goal: "grab audio", repo_url: OK_URL });
    expect(res.content).toMatchObject({ message: "pg exploded" });
  });

  it("mints a distinct session and run id per call", async () => {
    const { tool } = harness();
    const a = (await tool.handler({ goal: "one", repo_url: OK_URL })).content as Record<
      string,
      string
    >;
    const b = (await tool.handler({ goal: "two", repo_url: OK_URL })).content as Record<
      string,
      string
    >;
    expect(a.session_id).not.toBe(b.session_id);
    expect(a.repo_run_id).not.toBe(b.repo_run_id);
  });
});

describe("use_repo optional inputs", () => {
  it("passes through a trimmed input_url and input_filename", async () => {
    const { tool } = harness();
    const res = await tool.handler({
      goal: "transcode",
      repo_url: OK_URL,
      input_url: "  https://example.test/a.mp4  ",
      input_filename: "  a.mp4  ",
    });
    expect(res.content).toMatchObject({
      input_url: "https://example.test/a.mp4",
      input_filename: "a.mp4",
    });
  });

  it("omits non-string optional inputs", async () => {
    const { tool } = harness();
    const res = await tool.handler({
      goal: "transcode",
      repo_url: OK_URL,
      input_url: 7,
      input_filename: null,
    });
    const c = res.content as Record<string, unknown>;
    expect(c.input_url).toBeUndefined();
    expect(c.input_filename).toBeUndefined();
  });
});

describe("use_repo limit clamping", () => {
  async function limitsFor(limits: unknown) {
    const { tool } = harness();
    const res = await tool.handler({ goal: "grab audio", repo_url: OK_URL, limits });
    return (res.content as { limits: Record<string, number> }).limits;
  }

  it("passes through in-range limits", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 2048 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 2048 });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 999_999,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors fractional attempt and disk values", async () => {
    expect(await limitsFor({ max_install_attempts: 2.9, disk_mb: 1024.7 })).toEqual({
      max_install_attempts: 2,
      disk_mb: 1024,
    });
  });

  it("drops zero, negative, and non-numeric limits instead of clamping them up", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "lots",
      }),
    ).toEqual({});
  });

  it("returns an empty object for a missing or non-object limits field", async () => {
    for (const raw of [undefined, null, "none", 5, true]) {
      expect(await limitsFor(raw)).toEqual({});
    }
  });

  it("ignores unknown keys in the limits object", async () => {
    expect(await limitsFor({ gpu_count: 4, wall_clock_minutes: 5 })).toEqual({
      wall_clock_minutes: 5,
    });
  });
});
