/**
 * createUseRepoTool — the use_repo MCP adapter (Capability Network).
 *
 * The handler's job is validation, limit clamping, and a specific
 * write order: container task → dispatch (which creates the session
 * row) → repo_run insert, because repo_run.session_id has an FK to
 * session.id. That ordering is load-bearing and invisible to a type
 * checker, so it is asserted directly here, along with the two partial
 * -failure envelopes (dispatch_failed, repo_run_create_failed) that
 * tell the agent not to sit waiting on a run that never started.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
  Task,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool } from "./use-repo.js";

const GOOD_URL = "https://github.com/yt-dlp/yt-dlp";

function harness(
  opts: {
    agent?: { id: string } | null;
    dispatchImpl?: (...args: unknown[]) => Promise<unknown>;
    repoRunImpl?: (...args: unknown[]) => Promise<unknown>;
    agentId?: string;
  } = {},
) {
  const order: string[] = [];
  const agent = opts.agent === undefined ? { id: "agent_a" } : opts.agent;

  const findById = vi.fn(async () => {
    order.push("agent.findById");
    return agent as unknown as null;
  });
  const taskCreate = vi.fn(async (row: Partial<Task>) => {
    order.push("task.create");
    return { ...row, status: "pending" } as unknown as Task;
  });
  const dispatchTask = vi.fn(
    opts.dispatchImpl ??
      (async () => {
        order.push("dispatch.dispatchTask");
        return undefined;
      }),
  );
  const repoRunCreate = vi.fn(
    opts.repoRunImpl ??
      (async () => {
        order.push("repoRun.create");
        return undefined;
      }),
  );

  const tool = createUseRepoTool(
    { agentId: opts.agentId ?? "agent_a" },
    {
      agentRepo: { findById } as unknown as AgentRepository,
      taskRepo: { create: taskCreate } as unknown as TaskRepository,
      repoRunRepo: { create: repoRunCreate } as unknown as RepoRunRepository,
      dispatchService: {
        dispatchTask,
      } as unknown as DispatchService,
    },
  );

  return { tool, findById, taskCreate, dispatchTask, repoRunCreate, order };
}

describe("use_repo tool descriptor", () => {
  it("requires goal and repo_url and rejects unknown properties", () => {
    const { tool } = harness();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });

  it("documents the three limit knobs the handler actually honours", () => {
    const { tool } = harness();
    const props = tool.schema.properties as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(Object.keys(props.limits?.properties ?? {}).sort()).toEqual([
      "disk_mb",
      "max_install_attempts",
      "wall_clock_minutes",
    ]);
  });
});

describe("happy path", () => {
  it("creates the task, dispatches, then inserts repo_run — in that order", async () => {
    const { tool, order } = harness();

    const result = await tool.handler({
      goal: "Extract the tables from this PDF as JSON",
      repo_url: GOOD_URL,
    });

    expect(result.isError).toBeFalsy();
    // repo_run.session_id FKs to session.id, which dispatch creates.
    expect(order).toEqual([
      "agent.findById",
      "task.create",
      "dispatch.dispatchTask",
      "repoRun.create",
    ]);
  });

  it("returns the ids, pending status and a watch url for the new run", async () => {
    const { tool, repoRunCreate, taskCreate } = harness();

    const result = await tool.handler({
      goal: "Download the audio track as mp3",
      repo_url: GOOD_URL,
    });

    const content = result.content as Record<string, string>;
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.task_id).toMatch(/^task_/);
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(
      `/capabilities/runs/${content.repo_run_id}`,
    );
    expect(content.note).toContain("poll");

    // The ids reported back are the ids actually written.
    const runRow = repoRunCreate.mock.calls[0]?.[0] as Record<string, string>;
    const taskRow = taskCreate.mock.calls[0]?.[0] as Record<string, string>;
    expect(runRow.id).toBe(content.repo_run_id);
    expect(runRow.session_id).toBe(content.session_id);
    expect(runRow.task_id).toBe(content.task_id);
    expect(taskRow.id).toBe(content.task_id);
  });

  it("dispatches under the same pre-minted session id it writes to repo_run", async () => {
    const { tool, dispatchTask, repoRunCreate } = harness();

    await tool.handler({ goal: "do a thing", repo_url: GOOD_URL });

    const dispatched = dispatchTask.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const runRow = repoRunCreate.mock.calls[0]?.[0] as Record<string, string>;
    // If these diverge, composeDispatchPayload finds no repo_run and the
    // session is marked failed.
    expect(dispatched.sessionIdOverride).toBe(runRow.session_id);
  });

  it("dispatches a run_repo session carrying the goal as the intent", async () => {
    const { tool, dispatchTask, taskCreate } = harness();

    await tool.handler({ goal: "convert the csv", repo_url: GOOD_URL });

    const dispatched = dispatchTask.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(dispatched).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: "convert the csv",
      reason: { kind: "fresh" },
    });
    expect(dispatched.task).toBe(await taskCreate.mock.results[0]?.value);
  });

  it("pins the container task to the resolved agent as both creator and assignee", async () => {
    const { tool, taskCreate } = harness({ agent: { id: "agent_resolved" } });

    await tool.handler({ goal: "do a thing", repo_url: GOOD_URL });

    expect(taskCreate.mock.calls[0]?.[0]).toMatchObject({
      assignee_id: "agent_resolved",
      creator_id: "agent_resolved",
      creator_type: "agent",
      priority: "medium",
    });
  });

  it("looks the caller up by the context agent id", async () => {
    const { tool, findById } = harness({ agentId: "agent_ctx" });
    await tool.handler({ goal: "do a thing", repo_url: GOOD_URL });
    expect(findById).toHaveBeenCalledWith("agent_ctx");
  });

  it("trims the goal and repo_url before using them", async () => {
    const { tool, repoRunCreate } = harness();

    await tool.handler({
      goal: "   extract tables   ",
      repo_url: `  ${GOOD_URL}  `,
    });

    expect(repoRunCreate.mock.calls[0]?.[0]).toMatchObject({
      goal: "extract tables",
      repo_url: GOOD_URL,
    });
  });

  it("echoes the optional sandbox input back to the agent", async () => {
    const { tool } = harness();

    const result = await tool.handler({
      goal: "extract tables",
      repo_url: GOOD_URL,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves the input fields undefined when not supplied", async () => {
    const { tool } = harness();
    const result = await tool.handler({ goal: "g", repo_url: GOOD_URL });
    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("container task title", () => {
  it("collapses whitespace in the goal", async () => {
    const { tool, taskCreate } = harness();

    await tool.handler({
      goal: "extract\n\ttables   from\nthe pdf",
      repo_url: GOOD_URL,
    });

    expect(taskCreate.mock.calls[0]?.[0]).toMatchObject({
      title: "extract tables from the pdf",
    });
  });

  it("keeps an 80-character title whole", async () => {
    const { tool, taskCreate } = harness();
    const goal = "g".repeat(80);

    await tool.handler({ goal, repo_url: GOOD_URL });

    const row = taskCreate.mock.calls[0]?.[0] as Record<string, string>;
    expect(row.title).toBe(goal);
    expect(row.title).toHaveLength(80);
  });

  it("ellipsizes a longer title to 78 chars but keeps the full goal as the description", async () => {
    const { tool, taskCreate } = harness();
    const goal = "g".repeat(200);

    await tool.handler({ goal, repo_url: GOOD_URL });

    const row = taskCreate.mock.calls[0]?.[0] as Record<string, string>;
    expect(row.title).toBe("g".repeat(77) + "…");
    expect(row.description).toBe(goal);
  });
});

describe("input validation", () => {
  it("rejects a missing, blank or non-string goal", async () => {
    for (const goal of [undefined, "", "   ", 42]) {
      const { tool, findById } = harness();
      const result = await tool.handler({ goal, repo_url: GOOD_URL });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
      // nothing is written for a bad goal
      expect(findById).not.toHaveBeenCalled();
    }
  });

  it("accepts github.com and its subdomains over https", async () => {
    for (const url of [
      "https://github.com/owner/repo",
      "https://www.github.com/owner/repo",
      "https://GitHub.com/owner/repo",
      "https://github.com/owner/repo.git",
    ]) {
      const { tool } = harness();
      const result = await tool.handler({ goal: "g", repo_url: url });
      expect(result.isError, url).toBeFalsy();
    }
  });

  it("rejects non-GitHub hosts, plain http, and look-alike domains", async () => {
    for (const url of [
      "",
      "   ",
      "http://github.com/owner/repo",
      "https://gitlab.com/owner/repo",
      "https://notgithub.com/owner/repo",
      "https://github.com.evil.test/owner/repo",
      "git@github.com:owner/repo.git",
      "ssh://github.com/owner/repo",
      "not a url at all",
    ]) {
      const { tool, findById } = harness();
      const result = await tool.handler({ goal: "g", repo_url: url });
      expect(result.isError, url).toBe(true);
      expect(result.content, url).toMatchObject({ error: "invalid_repo_url" });
      expect(findById).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-string repo_url", async () => {
    const { tool } = harness();
    const result = await tool.handler({ goal: "g", repo_url: 42 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
  });

  it("checks the goal before the repo_url", async () => {
    const { tool } = harness();
    const result = await tool.handler({ goal: "", repo_url: "nonsense" });
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });
});

describe("limit clamping", () => {
  it("passes sane limits through untouched", async () => {
    const { tool } = harness();

    const result = await tool.handler({
      goal: "g",
      repo_url: GOOD_URL,
      limits: {
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 2048,
      },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 2048,
    });
  });

  it("caps each limit at its ceiling", async () => {
    const { tool } = harness();

    const result = await tool.handler({
      goal: "g",
      repo_url: GOOD_URL,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 500_000,
      },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    const { tool } = harness();

    const result = await tool.handler({
      goal: "g",
      repo_url: GOOD_URL,
      limits: { max_install_attempts: 2.9, disk_mb: 1024.7 },
    });

    expect(result.content.limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 1024,
    });
  });

  it("drops zero, negative and non-numeric limits so the defaults apply", async () => {
    const { tool } = harness();

    const result = await tool.handler({
      goal: "g",
      repo_url: GOOD_URL,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -3,
        disk_mb: "2048",
      },
    });

    expect(result.content.limits).toEqual({});
  });

  it("treats a missing, null or non-object limits as no limits", async () => {
    for (const limits of [undefined, null, "fast", 7, []]) {
      const { tool } = harness();
      const result = await tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
        limits,
      });
      expect(result.content.limits).toEqual({});
    }
  });
});

describe("failure envelopes", () => {
  it("reports agent_not_found and writes nothing when the caller is unknown", async () => {
    const { tool, taskCreate, dispatchTask, repoRunCreate } = harness({
      agent: null,
    });

    const result = await tool.handler({ goal: "g", repo_url: GOOD_URL });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(dispatchTask).not.toHaveBeenCalled();
    expect(repoRunCreate).not.toHaveBeenCalled();
  });

  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const { tool, repoRunCreate } = harness({
      dispatchImpl: async () => {
        throw new Error("no daemon online");
      },
    });

    const result = await tool.handler({ goal: "g", repo_url: GOOD_URL });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    // No session row to hang a repo_run off of.
    expect(repoRunCreate).not.toHaveBeenCalled();
  });

  it("surfaces repo_run_create_failed rather than letting the agent wait on an orphan session", async () => {
    const { tool } = harness({
      repoRunImpl: async () => {
        throw new Error("duplicate key value violates unique constraint");
      },
    });

    const result = await tool.handler({ goal: "g", repo_url: GOOD_URL });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: expect.stringContaining("duplicate key"),
    });
  });

  it("stringifies non-Error throws from dispatch and the repo_run insert", async () => {
    const dispatched = harness({
      dispatchImpl: async () => {
        throw "daemon vanished";
      },
    });
    expect(
      (await dispatched.tool.handler({ goal: "g", repo_url: GOOD_URL }))
        .content,
    ).toMatchObject({ error: "dispatch_failed", message: "daemon vanished" });

    const inserted = harness({
      repoRunImpl: async () => {
        throw "pg gone";
      },
    });
    expect(
      (await inserted.tool.handler({ goal: "g", repo_url: GOOD_URL })).content,
    ).toMatchObject({ error: "repo_run_create_failed", message: "pg gone" });
  });
});
