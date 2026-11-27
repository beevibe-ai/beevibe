/**
 * use_repo tool tests — the Agent App Store's verb (#149).
 *
 * The handler is the ordering-sensitive part of the capability network:
 * `repo_run.session_id` has an FK to `session.id`, so the session row
 * (minted by dispatchTask under our pre-minted override) must land
 * BEFORE the repo_run insert. Both of those are fallible, and each
 * failure mode returns a *different* error code the calling agent
 * branches on. That ordering and those codes are what's locked here,
 * alongside the input validation and the limit clamps.
 *
 * Everything is driven through vitest fakes — no Postgres, no daemon.
 */

import { describe, expect, it, vi } from "vitest";
import type { Agent, Task } from "@beevibe/core";
import type { DispatchInput } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const AGENT_ID = "agent_caller";

function fakeAgent(): Agent {
  return { id: AGENT_ID, name: "Caller" } as unknown as Agent;
}

/**
 * Records the order of the two writes that have an FK dependency, so a
 * regression that flips them fails loudly rather than only breaking
 * against a real database.
 */
interface Harness {
  services: UseRepoServices;
  calls: string[];
  created: { task?: Record<string, unknown>; repoRun?: Record<string, unknown> };
}

function harness(
  opts: {
    agent?: Agent | undefined;
    dispatchError?: Error;
    repoRunError?: Error;
  } = {},
): Harness {
  const calls: string[] = [];
  const created: Harness["created"] = {};
  const agent = "agent" in opts ? opts.agent : fakeAgent();

  const services = {
    agentRepo: {
      findById: vi.fn(async () => {
        calls.push("findById");
        return agent;
      }),
    },
    taskRepo: {
      create: vi.fn(async (row: Record<string, unknown>) => {
        calls.push("taskRepo.create");
        created.task = row;
        return row as unknown as Task;
      }),
    },
    repoRunRepo: {
      create: vi.fn(async (row: Record<string, unknown>) => {
        calls.push("repoRunRepo.create");
        if (opts.repoRunError) throw opts.repoRunError;
        created.repoRun = row;
        return row;
      }),
    },
    dispatchService: {
      dispatchTask: vi.fn(async () => {
        calls.push("dispatchTask");
        if (opts.dispatchError) throw opts.dispatchError;
        return {};
      }),
    },
  } as unknown as UseRepoServices;

  return { services, calls, created };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: AGENT_ID }, h.services);
}

/** The dispatch request the handler built, typed. */
function dispatched(h: Harness): DispatchInput {
  return vi.mocked(h.services.dispatchService.dispatchTask).mock.calls[0]![0];
}

const GOOD = { goal: "Extract tables as JSON", repo_url: "https://github.com/acme/pdfplumber" };

describe("use_repo — tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo — input validation", () => {
  it("rejects a missing goal before touching any service", async () => {
    const h = harness();
    const res = await tool(h).handler({ repo_url: GOOD.repo_url });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    // Validation is cheap and must precede the agent lookup / writes.
    expect(h.calls).toEqual([]);
  });

  it("rejects a whitespace-only goal", async () => {
    const h = harness();
    const res = await tool(h).handler({ goal: "   \n ", repo_url: GOOD.repo_url });
    expect(res.content.error).toBe("invalid_goal");
  });

  it("rejects a non-string goal", async () => {
    const h = harness();
    const res = await tool(h).handler({ goal: 42, repo_url: GOOD.repo_url });
    expect(res.content.error).toBe("invalid_goal");
  });

  // The URL gate is a real security boundary, not a typo check: the repo
  // is cloned inside a sandbox that then runs its install steps, so a
  // non-GitHub or plaintext host must never reach the daemon.
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 7],
    ["http (not https)", "http://github.com/acme/repo"],
    ["a non-github host", "https://gitlab.com/acme/repo"],
    ["a lookalike host", "https://github.com.evil.test/acme/repo"],
    ["unparseable", "not a url"],
    ["an ssh remote", "git@github.com:acme/repo.git"],
  ])("rejects repo_url that is %s", async (_label, repoUrl) => {
    const h = harness();
    const res = await tool(h).handler({ goal: GOOD.goal, repo_url: repoUrl });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(h.calls).toEqual([]);
  });

  it.each([
    "https://github.com/acme/repo",
    "https://www.github.com/acme/repo",
    "https://GitHub.com/acme/repo",
    "https://github.com/acme/repo.git",
  ])("accepts the GitHub HTTPS URL %s", async (repoUrl) => {
    const h = harness();
    const res = await tool(h).handler({ goal: GOOD.goal, repo_url: repoUrl });
    expect(res.isError).toBeUndefined();
    expect(h.created.repoRun?.repo_url).toBe(repoUrl);
  });

  it("reports agent_not_found when the caller's row is gone", async () => {
    const h = harness({ agent: undefined });
    const res = await tool(h).handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    // Nothing was written on behalf of an agent that doesn't exist.
    expect(h.calls).toEqual(["findById"]);
  });
});

describe("use_repo — happy path", () => {
  it("writes session before repo_run, and returns the ids", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBeUndefined();
    // The FK ordering contract: dispatchTask (which inserts the session
    // row) strictly precedes the repo_run insert.
    expect(h.calls).toEqual([
      "findById",
      "taskRepo.create",
      "dispatchTask",
      "repoRunRepo.create",
    ]);

    expect(res.content.status).toBe("pending");
    expect(res.content.repo_run_id).toMatch(/^repo_/);
    expect(res.content.session_id).toMatch(/^sess_/);
    expect(res.content.task_id).toBe(h.created.task?.id);
    expect(res.content.watch_url).toBe(`/capabilities/runs/${res.content.repo_run_id}`);
  });

  it("pins the repo_run to the same session id that was dispatched", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);

    // A mismatch here is the FK violation the pre-minting exists to avoid.
    expect(h.created.repoRun?.session_id).toBe(dispatched(h).sessionIdOverride);
    expect(h.created.repoRun?.session_id).toBe(res.content.session_id);
  });

  it("dispatches a run_repo session carrying the goal as intent", async () => {
    const h = harness();
    await tool(h).handler(GOOD);

    const d = dispatched(h);
    expect(d.type).toBe("run_repo");
    expect(d.intent).toBe(GOOD.goal);
    expect(d.agentId).toBe(AGENT_ID);
    expect(d.reason).toEqual({ kind: "fresh" });
  });

  it("creates the container task owned by the calling agent", async () => {
    const h = harness();
    await tool(h).handler(GOOD);

    expect(h.created.task).toMatchObject({
      title: GOOD.goal,
      description: GOOD.goal,
      priority: "medium",
      assignee_id: AGENT_ID,
      creator_id: AGENT_ID,
      creator_type: "agent",
    });
  });

  it("records the repo_run as pending against the caller and container task", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);

    expect(h.created.repoRun).toMatchObject({
      id: res.content.repo_run_id,
      task_id: res.content.task_id,
      agent_id: AGENT_ID,
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  it("trims the goal and echoes optional input fields back", async () => {
    const h = harness();
    const res = await tool(h).handler({
      goal: "  fetch the audio  ",
      repo_url: GOOD.repo_url,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(h.created.repoRun?.goal).toBe("fetch the audio");
    expect(res.content.input_url).toBe("https://example.test/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("leaves the optional input fields undefined when not supplied", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });

  it("ignores non-string input_url / input_filename", async () => {
    const h = harness();
    const res = await tool(h).handler({ ...GOOD, input_url: 1, input_filename: {} });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo — container task title", () => {
  it("collapses runs of whitespace", async () => {
    const h = harness();
    await tool(h).handler({ ...GOOD, goal: "do\n\n  this   thing" });
    expect(h.created.task?.title).toBe("do this thing");
  });

  it("leaves an 80-char goal intact", async () => {
    const h = harness();
    const goal = "x".repeat(80);
    await tool(h).handler({ ...GOOD, goal });
    expect(h.created.task?.title).toBe(goal);
    // The untruncated goal still reaches the description in full.
    expect(h.created.task?.description).toBe(goal);
  });

  it("ellipsizes past 80 chars to keep the inbox row scannable", async () => {
    const h = harness();
    const goal = "y".repeat(200);
    await tool(h).handler({ ...GOOD, goal });
    const title = h.created.task?.title as string;
    expect(title).toBe("y".repeat(77) + "…");
    expect(title).toHaveLength(78);
    expect(h.created.task?.description).toBe(goal);
  });
});

describe("use_repo — limits clamping", () => {
  // The caps are the sandbox's protection against a runaway child agent,
  // so an agent asking for more must be clamped, not honored.
  it("clamps every limit to its ceiling", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: 999, max_install_attempts: 50, disk_mb: 999_999 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
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

  it("floors fractional counts", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { max_install_attempts: 2.9, disk_mb: 100.7 },
    });
    expect(res.content.limits).toEqual({ max_install_attempts: 2, disk_mb: 100 });
  });

  it("keeps wall_clock_minutes fractional (it is a duration, not a count)", async () => {
    const h = harness();
    const res = await tool(h).handler({ ...GOOD, limits: { wall_clock_minutes: 1.5 } });
    expect(res.content.limits).toEqual({ wall_clock_minutes: 1.5 });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["non-numeric", "20"],
  ])("drops a %s limit rather than passing it on", async (_label, value) => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: value, max_install_attempts: value, disk_mb: value },
    });
    expect(res.content.limits).toEqual({});
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a non-object", "lots"],
  ])("returns empty limits when limits is %s", async (_label, limits) => {
    const h = harness();
    const res = await tool(h).handler({ ...GOOD, limits });
    expect(res.content.limits).toEqual({});
  });
});

describe("use_repo — failure modes", () => {
  it("returns dispatch_failed and never inserts the repo_run", async () => {
    const h = harness({ dispatchError: new Error("daemon offline") });
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("dispatch_failed");
    expect(res.content.message).toBe("daemon offline");
    // An FK-violating orphan insert would be worse than the failure.
    expect(h.calls).not.toContain("repoRunRepo.create");
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait forever", async () => {
    // The session row landed but repo_run didn't — composeDispatchPayload
    // self-recovers by failing the session, but the agent has to be told.
    const h = harness({ repoRunError: new Error("unique violation") });
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("repo_run_create_failed");
    expect(res.content.message).toBe("unique violation");
  });

  it.each([
    ["dispatch", "dispatchError", "dispatch_failed"],
    ["repo_run insert", "repoRunError", "repo_run_create_failed"],
  ])("stringifies a non-Error thrown from %s", async (_label, key, code) => {
    const h = harness({ [key]: "plain string boom" as unknown as Error });
    const res = await tool(h).handler(GOOD);
    expect(res.content.error).toBe(code);
    expect(res.content.message).toBe("plain string boom");
  });
});
