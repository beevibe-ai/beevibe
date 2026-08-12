/**
 * use_repo handler tests.
 *
 * The tool mints three rows across three collaborators in a specific
 * order — container task, then the dispatched session, then the
 * repo_run whose FK points at that session — and each step has a
 * failure envelope the calling agent branches on. None of that needs a
 * database: the ordering constraint and the error mapping are adapter
 * logic, and recording fakes assert them directly.
 *
 * Also covered: the input guards (goal, GitHub-URL shape) and the
 * limits clamp, which is the only place a caller-supplied number turns
 * into a sandbox resource cap.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";
import type { AgentTool } from "./types.js";

const AGENT = { id: "agent_1", name: "Scout" };

class Fakes {
  agentFound: { id: string; name: string } | undefined = AGENT;
  taskCreates: Record<string, unknown>[] = [];
  repoRunCreates: Record<string, unknown>[] = [];
  dispatchCalls: Record<string, unknown>[] = [];
  dispatchThrows: unknown = null;
  repoRunThrows: unknown = null;

  get services(): UseRepoServices {
    return {
      agentRepo: {
        findById: async (id: string) =>
          this.agentFound && this.agentFound.id === id
            ? this.agentFound
            : undefined,
      } as unknown as AgentRepository,
      taskRepo: {
        create: async (input: Record<string, unknown>) => {
          this.taskCreates.push(input);
          return { ...input, status: "pending" };
        },
      } as unknown as TaskRepository,
      repoRunRepo: {
        create: async (input: Record<string, unknown>) => {
          this.repoRunCreates.push(input);
          if (this.repoRunThrows) throw this.repoRunThrows;
          return input;
        },
      } as unknown as RepoRunRepository,
      dispatchService: {
        dispatchTask: async (input: Record<string, unknown>) => {
          this.dispatchCalls.push(input);
          if (this.dispatchThrows) throw this.dispatchThrows;
          return { sessionId: input.sessionIdOverride };
        },
      } as unknown as DispatchService,
    };
  }
}

let fakes: Fakes;

function tool(agentId = "agent_1"): AgentTool {
  return createUseRepoTool({ agentId }, fakes.services);
}

const VALID = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

beforeEach(() => {
  fakes = new Fakes();
});

describe("createUseRepoTool", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool();
    expect(t.name).toBe("use_repo");
    expect((t.schema as { required: string[] }).required).toEqual([
      "goal",
      "repo_url",
    ]);
  });
});

describe("input validation", () => {
  it("rejects a missing, blank or non-string goal", async () => {
    for (const goal of [undefined, "", "   ", 42]) {
      const res = await tool().handler({ ...VALID, goal });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("invalid_goal");
    }
    expect(fakes.taskCreates).toEqual([]);
  });

  it("accepts github.com and its subdomains over https", async () => {
    for (const repo_url of [
      "https://github.com/owner/repo",
      "https://www.github.com/owner/repo",
      "https://GitHub.com/owner/repo",
    ]) {
      const res = await tool().handler({ ...VALID, repo_url });
      expect(res.isError).toBeUndefined();
    }
  });

  it("rejects non-GitHub hosts, plain http, and unparseable URLs", async () => {
    for (const repo_url of [
      undefined,
      "",
      "http://github.com/owner/repo",
      "https://gitlab.com/owner/repo",
      "https://notgithub.com/owner/repo",
      // Suffix match must be anchored on a dot boundary.
      "https://evil-github.com/owner/repo",
      "https://github.com.evil.io/owner/repo",
      "not a url",
      "github.com/owner/repo",
    ]) {
      const res = await tool().handler({ ...VALID, repo_url });
      expect(res.isError, `expected ${String(repo_url)} to be rejected`).toBe(
        true,
      );
      expect(res.content.error).toBe("invalid_repo_url");
    }
    expect(fakes.taskCreates).toEqual([]);
  });

  it("reports agent_not_found without creating anything", async () => {
    fakes.agentFound = undefined;

    const res = await tool().handler(VALID);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(fakes.taskCreates).toEqual([]);
    expect(fakes.dispatchCalls).toEqual([]);
  });
});

describe("happy path", () => {
  it("creates the container task assigned and credited to the caller", async () => {
    await tool().handler(VALID);

    expect(fakes.taskCreates).toHaveLength(1);
    expect(fakes.taskCreates[0]!).toMatchObject({
      title: VALID.goal,
      description: VALID.goal,
      priority: "medium",
      assignee_id: "agent_1",
      creator_id: "agent_1",
      creator_type: "agent",
    });
  });

  it("truncates a long goal into an ellipsized task title", async () => {
    const goal = "x".repeat(200);
    await tool().handler({ ...VALID, goal });

    // 77 kept + the ellipsis: the cut is deliberately under the 80-char
    // budget so the inbox row never wraps.
    const title = fakes.taskCreates[0]!.title as string;
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
    expect(fakes.taskCreates[0]!.description).toBe(goal);
  });

  it("leaves a title at exactly the 80-char boundary intact", async () => {
    const goal = "y".repeat(80);
    await tool().handler({ ...VALID, goal });

    expect(fakes.taskCreates[0]!.title).toBe(goal);
  });

  it("collapses whitespace in the task title but keeps the full description", async () => {
    const goal = "  Extract\n\ttables   from  the PDF  ";
    await tool().handler({ ...VALID, goal });

    expect(fakes.taskCreates[0]!.title).toBe("Extract tables from the PDF");
    expect(fakes.taskCreates[0]!.description).toBe(goal.trim());
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    await tool().handler(VALID);

    expect(fakes.dispatchCalls).toHaveLength(1);
    expect(fakes.dispatchCalls[0]!).toMatchObject({
      agentId: "agent_1",
      type: "run_repo",
      intent: VALID.goal,
      reason: { kind: "fresh" },
    });
    expect(fakes.dispatchCalls[0]!.sessionIdOverride).toEqual(
      expect.any(String),
    );
  });

  it("inserts repo_run only after dispatch, against the same session id", async () => {
    // repo_run.session_id is an FK to session.id, so the session row has
    // to exist first — this ordering is the reason the ids are minted up
    // front rather than read back out of dispatch.
    const res = await tool().handler(VALID);

    const dispatchedSid = fakes.dispatchCalls[0]!.sessionIdOverride;
    expect(fakes.repoRunCreates).toHaveLength(1);
    expect(fakes.repoRunCreates[0]!).toMatchObject({
      session_id: dispatchedSid,
      task_id: fakes.taskCreates[0]!.id,
      agent_id: "agent_1",
      goal: VALID.goal,
      repo_url: VALID.repo_url,
      status: "pending",
    });
    expect(res.content.session_id).toBe(dispatchedSid);
  });

  it("returns the run ids, a pending status and the watch url", async () => {
    const res = await tool().handler(VALID);

    const runId = fakes.repoRunCreates[0]!.id as string;
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatchObject({
      repo_run_id: runId,
      task_id: fakes.taskCreates[0]!.id,
      status: "pending",
      watch_url: `/capabilities/runs/${runId}`,
    });
    expect(res.content.note).toMatch(/poll/i);
  });

  it("echoes the trimmed input_url and input_filename", async () => {
    const res = await tool().handler({
      ...VALID,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(res.content.input_url).toBe("https://example.com/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("omits the input fields when they are absent or not strings", async () => {
    const res = await tool().handler({ ...VALID, input_url: 5 });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });

  it("mints a distinct session and repo_run id per call", async () => {
    const first = await tool().handler(VALID);
    const second = await tool().handler(VALID);

    expect(first.content.repo_run_id).not.toBe(second.content.repo_run_id);
    expect(first.content.session_id).not.toBe(second.content.session_id);
    expect(first.content.task_id).not.toBe(second.content.task_id);
  });
});

describe("limits", () => {
  it("passes sane limits through, flooring the integer caps", async () => {
    const res = await tool().handler({
      ...VALID,
      limits: {
        wall_clock_minutes: 15,
        max_install_attempts: 3.7,
        disk_mb: 512.9,
      },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const res = await tool().handler({
      ...VALID,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("drops non-positive and non-numeric limits so defaults apply", async () => {
    const res = await tool().handler({
      ...VALID,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      },
    });

    expect(res.content.limits).toEqual({});
  });

  it("treats a missing or non-object limits as empty", async () => {
    for (const limits of [undefined, null, "20m", 20]) {
      const res = await tool().handler({ ...VALID, limits });
      expect(res.content.limits).toEqual({});
    }
  });
});

describe("failure envelopes", () => {
  it("reports dispatch_failed and skips the repo_run insert", async () => {
    fakes.dispatchThrows = new Error("no runtime online");

    const res = await tool().handler(VALID);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(fakes.repoRunCreates).toEqual([]);
  });

  it("reports repo_run_create_failed once the session already landed", async () => {
    // Orphan-session case: it self-recovers when composeDispatchPayload
    // finds no repo_run, but the agent must not be left waiting silently.
    fakes.repoRunThrows = new Error("duplicate key");

    const res = await tool().handler(VALID);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    expect(fakes.dispatchCalls).toHaveLength(1);
  });

  it("stringifies non-Error throws on both failure paths", async () => {
    fakes.dispatchThrows = "socket hang up";
    expect((await tool().handler(VALID)).content).toEqual({
      error: "dispatch_failed",
      message: "socket hang up",
    });

    fakes = new Fakes();
    fakes.repoRunThrows = "socket hang up";
    expect((await tool().handler(VALID)).content).toEqual({
      error: "repo_run_create_failed",
      message: "socket hang up",
    });
  });
});
