/**
 * use_repo unit tests.
 *
 * The tool is the Agent App Store's only verb, and it had no test file —
 * the whole surface (URL gating, limit clamping, and the ordering
 * contract between dispatch and the repo_run insert) was only exercised
 * by the Postgres-backed e2e path.
 *
 * Two things here are load-bearing beyond "does it return the right
 * shape":
 *   - `repo_url` gating is a security boundary: whatever passes it gets
 *     cloned and executed inside the sandbox.
 *   - the session row must exist before the repo_run insert, because
 *     repo_run.session_id carries an FK to session.id. The source
 *     comment spells this out; these tests pin it.
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

const AGENT: Agent = { id: "agent_a", name: "Ada" } as unknown as Agent;

interface Harness {
  services: UseRepoServices;
  calls: string[];
  taskCreate: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  repoRunCreate: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: {
    agent?: Agent | undefined;
    dispatchImpl?: () => Promise<unknown>;
    repoRunImpl?: () => Promise<unknown>;
  } = {},
): Harness {
  // Shared ordered log — the dispatch-before-insert contract is only
  // observable as a sequence across two different fakes.
  const calls: string[] = [];

  const taskCreate = vi.fn(async (input: Record<string, unknown>) => {
    calls.push("task.create");
    return { ...input, status: "pending" } as unknown as Task;
  });
  const dispatchTask = vi.fn(async () => {
    calls.push("dispatch");
    return overrides.dispatchImpl ? await overrides.dispatchImpl() : {};
  });
  const repoRunCreate = vi.fn(async (input: Record<string, unknown>) => {
    calls.push("repoRun.create");
    if (overrides.repoRunImpl) await overrides.repoRunImpl();
    return input as unknown as RepoRun;
  });

  const services: UseRepoServices = {
    agentRepo: {
      findById: vi.fn(async () =>
        "agent" in overrides ? overrides.agent : AGENT,
      ),
    } as unknown as AgentRepository,
    taskRepo: { create: taskCreate } as unknown as TaskRepository,
    repoRunRepo: { create: repoRunCreate } as unknown as RepoRunRepository,
    dispatchService: { dispatchTask } as unknown as DispatchService,
  };

  return { services, calls, taskCreate, dispatchTask, repoRunCreate };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: "agent_a" }, h.services);
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo — input validation", () => {
  it("rejects a missing or blank goal before touching any service", async () => {
    const h = harness();
    for (const goal of [undefined, "", "   ", 42]) {
      const result = await tool(h).handler({ ...OK_INPUT, goal });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(h.taskCreate).not.toHaveBeenCalled();
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  // Anything that passes this gate is cloned and run inside the sandbox,
  // so the accept list stays narrow: HTTPS, github.com or a subdomain.
  it("accepts github.com and its subdomains over HTTPS", async () => {
    for (const repo_url of [
      "https://github.com/jsvine/pdfplumber",
      "https://www.github.com/jsvine/pdfplumber",
      "https://GitHub.com/jsvine/pdfplumber",
      "  https://github.com/jsvine/pdfplumber  ",
    ]) {
      const result = await tool(harness()).handler({ ...OK_INPUT, repo_url });
      expect(result.isError, repo_url).toBeFalsy();
    }
  });

  it("rejects non-HTTPS, non-github, lookalike and malformed repo_urls", async () => {
    const h = harness();
    for (const repo_url of [
      undefined,
      "",
      "   ",
      "http://github.com/a/b", // plaintext
      "git@github.com:a/b.git", // ssh
      "https://gitlab.com/a/b",
      "https://notgithub.com/a/b",
      "https://github.com.evil.example/a/b", // suffix lookalike
      "https://evilgithub.com/a/b",
      "not a url at all",
    ]) {
      const result = await tool(h).handler({ ...OK_INPUT, repo_url });
      expect(result.isError, String(repo_url)).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    }
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("returns agent_not_found when the caller's agent row is gone", async () => {
    const h = harness({ agent: undefined });
    const result = await tool(h).handler(OK_INPUT);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.taskCreate).not.toHaveBeenCalled();
  });
});

describe("use_repo — happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const h = harness();
    const result = await tool(h).handler(OK_INPUT);

    expect(result.isError).toBeFalsy();
    // The FK on repo_run.session_id makes this order mandatory, not
    // incidental: dispatchTask is what writes the session row.
    expect(h.calls).toEqual(["task.create", "dispatch", "repoRun.create"]);

    const task = h.taskCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(task).toMatchObject({
      title: OK_INPUT.goal,
      description: OK_INPUT.goal,
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });

    const dispatch = h.dispatchTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(dispatch).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: OK_INPUT.goal,
      reason: { kind: "fresh" },
    });

    const run = h.repoRunCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    // The pre-minted session id has to be the same one dispatch was told
    // to use, or the daemon's composeDispatchPayload finds no repo_run.
    expect(run.session_id).toBe(dispatch.sessionIdOverride);
    expect(run).toMatchObject({
      task_id: task.id,
      agent_id: "agent_a",
      goal: OK_INPUT.goal,
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });

    expect(result.content).toMatchObject({
      repo_run_id: run.id,
      session_id: run.session_id,
      task_id: task.id,
      status: "pending",
      watch_url: `/capabilities/runs/${String(run.id)}`,
    });
  });

  it("trims the goal and repo_url before storing them", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "  extract tables  ",
      repo_url: "  https://github.com/a/b  ",
    });
    expect(h.repoRunCreate.mock.calls[0]?.[0]).toMatchObject({
      goal: "extract tables",
      repo_url: "https://github.com/a/b",
    });
  });

  // The title is what shows up as an inbox row, so it has to stay
  // scannable no matter how long the goal is.
  it("collapses whitespace and truncates the container task title at 80 chars", async () => {
    const h = harness();
    const goal = `${"a".repeat(200)}\n\n  b`;
    await tool(h).handler({ ...OK_INPUT, goal });
    const title = (h.taskCreate.mock.calls[0]?.[0] as { title: string }).title;
    // 77 kept chars + the ellipsis; comfortably under the 80-char cap.
    expect(title).toHaveLength(78);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
    // Only the title is squeezed — the description and the dispatch
    // intent keep the goal verbatim, newlines and all, because that's
    // what the child agent reads.
    expect(h.taskCreate.mock.calls[0]?.[0]).toMatchObject({ description: goal });
    expect(h.dispatchTask.mock.calls[0]?.[0]).toMatchObject({ intent: goal });
  });

  it("leaves a short title unmarked", async () => {
    const h = harness();
    await tool(h).handler({ ...OK_INPUT, goal: "short   goal" });
    expect(h.taskCreate.mock.calls[0]?.[0]).toMatchObject({ title: "short goal" });
  });

  it("echoes trimmed input_url / input_filename back to the caller", async () => {
    const h = harness();
    const result = await tool(h).handler({
      ...OK_INPUT,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });
    expect(result.content).toMatchObject({
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("omits input_url / input_filename when not supplied", async () => {
    const result = await tool(harness()).handler(OK_INPUT);
    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });

  it("mints a fresh repo_run / session / task id per call", async () => {
    const h = harness();
    const a = await tool(h).handler(OK_INPUT);
    const b = await tool(h).handler(OK_INPUT);
    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
  });
});

describe("use_repo — limits clamping", () => {
  it("clamps each limit to its documented ceiling", async () => {
    const result = await tool(harness()).handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 999, max_install_attempts: 50, disk_mb: 999_999 },
    });
    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("passes through in-range values and floors the integer limits", async () => {
    const result = await tool(harness()).handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 12.5, max_install_attempts: 3.9, disk_mb: 512.7 },
    });
    expect(result.content.limits).toEqual({
      wall_clock_minutes: 12.5,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  // Silently dropping a bad limit is the intended behavior: the sandbox
  // applies its own defaults, so a junk value must not become 0 or NaN.
  it("drops non-positive, non-numeric and unknown limit entries", async () => {
    const result = await tool(harness()).handler({
      ...OK_INPUT,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
        cpu_shares: 512,
      },
    });
    expect(result.content.limits).toEqual({});
  });

  it("treats a missing or non-object limits value as no limits", async () => {
    for (const limits of [undefined, null, "20", 20, []]) {
      const result = await tool(harness()).handler({ ...OK_INPUT, limits });
      expect(result.content.limits, JSON.stringify(limits)).toEqual({});
    }
  });
});

describe("use_repo — failure paths", () => {
  it("returns dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const h = harness({
      dispatchImpl: async () => {
        throw new Error("no runtime online");
      },
    });
    const result = await tool(h).handler(OK_INPUT);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(h.repoRunCreate).not.toHaveBeenCalled();
  });

  // The orphan-session case the source comment describes: the session
  // row landed, the repo_run didn't. It self-heals, but the agent has to
  // be told rather than left polling a run that will never exist.
  it("surfaces repo_run_create_failed rather than returning ids for an orphan session", async () => {
    const h = harness({
      repoRunImpl: async () => {
        throw new Error("duplicate key");
      },
    });
    const result = await tool(h).handler(OK_INPUT);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    expect(result.content.repo_run_id).toBeUndefined();
  });

  it("stringifies non-Error throws from either write", async () => {
    const dispatchFail = harness({
      dispatchImpl: async () => {
        throw "dispatch exploded";
      },
    });
    expect((await tool(dispatchFail).handler(OK_INPUT)).content).toMatchObject({
      error: "dispatch_failed",
      message: "dispatch exploded",
    });

    const insertFail = harness({
      repoRunImpl: async () => {
        throw "insert exploded";
      },
    });
    expect((await tool(insertFail).handler(OK_INPUT)).content).toMatchObject({
      error: "repo_run_create_failed",
      message: "insert exploded",
    });
  });
});
