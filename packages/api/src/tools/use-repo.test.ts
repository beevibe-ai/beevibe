/**
 * use_repo tool tests.
 *
 * The handler is a five-step sequence — validate, resolve the agent,
 * create the container task, dispatch, insert the repo_run — and every
 * step has a distinct failure envelope the calling agent branches on.
 * The ordering constraint documented in the module (session row before
 * repo_run, because repo_run.session_id has an FK to session.id) is
 * load-bearing, so it gets its own assertion rather than being implied
 * by the happy path.
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

const AGENT: Agent = {
  id: "agent_caller",
  name: "Caller",
  owner_id: "person_1",
  hierarchy_level: "ic",
  runtime_config: {} as Agent["runtime_config"],
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

interface Harness {
  services: UseRepoServices;
  calls: string[];
  created: Array<Record<string, unknown>>;
  dispatched: Array<Record<string, unknown>>;
  repoRuns: Array<Record<string, unknown>>;
}

function harness(
  overrides: {
    agent?: Agent | undefined;
    dispatch?: () => Promise<unknown>;
    createRepoRun?: () => Promise<unknown>;
  } = {},
): Harness {
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const repoRuns: Array<Record<string, unknown>> = [];

  const agentRepo = {
    findById: vi.fn(async () => {
      calls.push("findById");
      return "agent" in overrides ? overrides.agent : AGENT;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("taskRepo.create");
      created.push(input);
      return { ...input, status: "pending" } as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("repoRunRepo.create");
      repoRuns.push(input);
      if (overrides.createRepoRun) return overrides.createRepoRun();
      return input;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("dispatchTask");
      dispatched.push(input);
      if (overrides.dispatch) return overrides.dispatch();
      return {};
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    calls,
    created,
    dispatched,
    repoRuns,
  };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: "agent_caller" }, h.services);
}

const GOOD_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/acme/pdfplumber",
};

describe("use_repo tool descriptor", () => {
  it("exposes goal + repo_url as the required schema fields", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing goal before touching any service", async () => {
    const h = harness();
    const result = await tool(h).handler({ repo_url: GOOD_INPUT.repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.calls).toEqual([]);
  });

  it("rejects a whitespace-only goal", async () => {
    const h = harness();
    const result = await tool(h).handler({ ...GOOD_INPUT, goal: "   " });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["a non-GitHub host", "https://gitlab.com/acme/tool"],
    ["plain http", "http://github.com/acme/tool"],
    ["an unparseable string", "not a url"],
    ["a lookalike host", "https://notgithub.com/acme/tool"],
    ["an empty string", ""],
    ["a non-string", 42],
  ])("rejects %s as repo_url", async (_label, repo_url) => {
    const h = harness();
    const result = await tool(h).handler({ ...GOOD_INPUT, repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["the bare host", "https://github.com/acme/tool"],
    ["a subdomain", "https://www.github.com/acme/tool"],
  ])("accepts %s", async (_label, repo_url) => {
    const h = harness();
    const result = await tool(h).handler({ ...GOOD_INPUT, repo_url });

    expect(result.isError).toBeFalsy();
    expect(h.repoRuns[0]).toMatchObject({ repo_url });
  });

  it("returns agent_not_found when the caller no longer exists", async () => {
    const h = harness({ agent: undefined });
    const result = await tool(h).handler(GOOD_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // Bailed before the container task was created.
    expect(h.calls).toEqual(["findById"]);
  });
});

describe("use_repo happy path", () => {
  it("returns the minted ids plus a watch url", async () => {
    const h = harness();
    const result = await tool(h).handler(GOOD_INPUT);

    expect(result.isError).toBeFalsy();
    const content = result.content as Record<string, string>;
    expect(content.status).toBe("pending");
    expect(content.repo_run_id).toBeTruthy();
    expect(content.session_id).toBeTruthy();
    expect(content.task_id).toBeTruthy();
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    expect(content.note).toContain("Sandbox run started");
  });

  it("creates the session row before the repo_run row (FK ordering)", async () => {
    const h = harness();
    await tool(h).handler(GOOD_INPUT);

    expect(h.calls).toEqual([
      "findById",
      "taskRepo.create",
      "dispatchTask",
      "repoRunRepo.create",
    ]);
  });

  it("pins the container task to the resolved agent on both sides", async () => {
    const h = harness();
    await tool(h).handler(GOOD_INPUT);

    expect(h.created[0]).toMatchObject({
      title: GOOD_INPUT.goal,
      description: GOOD_INPUT.goal,
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const h = harness();
    const result = await tool(h).handler(GOOD_INPUT);

    const sessionId = (result.content as Record<string, string>).session_id;
    expect(h.dispatched[0]).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: GOOD_INPUT.goal,
      reason: { kind: "fresh" },
      sessionIdOverride: sessionId,
    });
  });

  it("hands the repo_run the same session and task ids it returns", async () => {
    const h = harness();
    const result = await tool(h).handler(GOOD_INPUT);
    const content = result.content as Record<string, string>;

    expect(h.repoRuns[0]).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_caller",
      goal: GOOD_INPUT.goal,
      repo_url: GOOD_INPUT.repo_url,
      status: "pending",
    });
  });

  it("trims goal and repo_url before they reach the repos", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "  do the thing  ",
      repo_url: `  ${GOOD_INPUT.repo_url}  `,
    });

    expect(h.repoRuns[0]).toMatchObject({
      goal: "do the thing",
      repo_url: GOOD_INPUT.repo_url,
    });
  });

  it("elides an over-long goal into an 80-char container task title", async () => {
    const h = harness();
    const goal = "x".repeat(200);
    await tool(h).handler({ ...GOOD_INPUT, goal });

    const title = h.created[0]?.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The full goal still reaches the description and the repo_run.
    expect(h.created[0]?.description).toBe(goal);
    expect(h.repoRuns[0]?.goal).toBe(goal);
  });

  it("collapses internal whitespace in the container task title", async () => {
    const h = harness();
    await tool(h).handler({ ...GOOD_INPUT, goal: "extract\n\n  the   tables" });

    expect(h.created[0]?.title).toBe("extract the tables");
  });

  it("passes optional input_url + input_filename back to the caller", async () => {
    const h = harness();
    const result = await tool(h).handler({
      ...GOOD_INPUT,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("omits input fields entirely when they are not strings", async () => {
    const h = harness();
    const result = await tool(h).handler({ ...GOOD_INPUT, input_url: 42 });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limit parsing", () => {
  it("returns an empty object when limits is absent", async () => {
    const h = harness();
    const result = await tool(h).handler(GOOD_INPUT);
    expect(result.content.limits).toEqual({});
  });

  it.each([
    ["null", null],
    ["a string", "20"],
  ])("returns an empty object when limits is %s", async (_label, limits) => {
    const h = harness();
    const result = await tool(h).handler({ ...GOOD_INPUT, limits });
    expect(result.content.limits).toEqual({});
  });

  it("passes through in-range limits untouched", async () => {
    const h = harness();
    const result = await tool(h).handler({
      ...GOOD_INPUT,
      limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 4096 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const h = harness();
    const result = await tool(h).handler({
      ...GOOD_INPUT,
      limits: {
        wall_clock_minutes: 999,
        max_install_attempts: 50,
        disk_mb: 1_000_000,
      },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt + disk values", async () => {
    const h = harness();
    const result = await tool(h).handler({
      ...GOOD_INPUT,
      limits: { max_install_attempts: 2.9, disk_mb: 512.7 },
    });

    expect(result.content.limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a non-number", "10"],
  ])("drops %s limit values", async (_label, value) => {
    const h = harness();
    const result = await tool(h).handler({
      ...GOOD_INPUT,
      limits: {
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      },
    });

    expect(result.content.limits).toEqual({});
  });
});

describe("use_repo failure envelopes", () => {
  it("reports dispatch_failed and never inserts a repo_run", async () => {
    const h = harness({
      dispatch: async () => {
        throw new Error("no daemon online");
      },
    });
    const result = await tool(h).handler(GOOD_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(h.calls).not.toContain("repoRunRepo.create");
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({
      dispatch: async () => {
        throw "capacity";
      },
    });
    const result = await tool(h).handler(GOOD_INPUT);

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "capacity",
    });
  });

  it("surfaces repo_run_create_failed rather than silently orphaning the session", async () => {
    const h = harness({
      createRepoRun: async () => {
        throw new Error("duplicate key");
      },
    });
    const result = await tool(h).handler(GOOD_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({
      createRepoRun: async () => {
        throw { code: 23503 };
      },
    });
    const result = await tool(h).handler(GOOD_INPUT);

    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(String(result.content.message)).toContain("object");
  });
});
