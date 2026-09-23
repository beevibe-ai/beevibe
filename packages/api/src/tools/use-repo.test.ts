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

/**
 * use_repo is the Capability Network's verb: it mints a container task,
 * dispatches a `run_repo` session, then inserts the repo_run row that
 * `composeDispatchPayload` looks up by session_id.
 *
 * Two things make it worth testing without a DB:
 *
 *   - The **ordering contract**. `repo_run.session_id` has an FK to
 *     `session.id`, so the dispatch (which creates the session row under
 *     our pre-minted `sessionIdOverride`) MUST land before the repo_run
 *     insert. The fakes below record call order so a refactor that
 *     reorders them fails here rather than as an FK violation in prod.
 *   - The **partial-failure envelopes**. A dispatch throw and a repo_run
 *     throw are different error codes, because the agent's recovery
 *     differs (nothing created vs. an orphan session that self-fails).
 */

const AGENT_ID = "agent_caller";
const OWNER_ID = "person_owner";
const REPO = "https://github.com/jsvine/pdfplumber";

function fakeAgentRepo(): AgentRepository {
  return {
    findById: vi.fn(async (id: string) =>
      id === AGENT_ID
        ? ({ id: AGENT_ID, owner_id: OWNER_ID, hierarchy_level: "ic" } as Agent)
        : undefined,
    ),
  } as unknown as AgentRepository;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date();
  return {
    id: "task_container",
    title: "container",
    status: "pending",
    priority: "medium",
    creator_id: AGENT_ID,
    creator_type: "agent",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * Shared services fake. `calls` is the ordered log of side effects, so a
 * test can assert dispatch-before-repo_run without reaching into a DB.
 */
function services(
  opts: { dispatchThrows?: unknown; repoRunThrows?: unknown } = {},
): UseRepoServices & {
  calls: string[];
  created: { task?: Parameters<TaskRepository["create"]>[0]; repoRun?: Record<string, unknown>; dispatch?: Record<string, unknown> };
} {
  const calls: string[] = [];
  const created: {
    task?: Parameters<TaskRepository["create"]>[0];
    repoRun?: Record<string, unknown>;
    dispatch?: Record<string, unknown>;
  } = {};

  const taskRepo = {
    create: vi.fn(async (input: Parameters<TaskRepository["create"]>[0]) => {
      calls.push("task.create");
      created.task = input;
      return makeTask({ id: input.id, title: input.title, description: input.description });
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("repoRun.create");
      created.repoRun = input;
      if (opts.repoRunThrows) throw opts.repoRunThrows;
      return input;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("dispatch");
      created.dispatch = input;
      if (opts.dispatchThrows) throw opts.dispatchThrows;
      return { session: { id: input.sessionIdOverride } };
    }),
  } as unknown as DispatchService;

  return {
    agentRepo: fakeAgentRepo(),
    taskRepo,
    repoRunRepo,
    dispatchService,
    calls,
    created,
  };
}

function tool(svc: UseRepoServices, agentId = AGENT_ID) {
  return createUseRepoTool({ agentId }, svc);
}

const GOOD_INPUT = { goal: "extract the tables from this PDF", repo_url: REPO };

describe("use_repo — input validation", () => {
  it("rejects a missing or blank goal before touching any service", async () => {
    const svc = services();
    for (const goal of [undefined, "", "   "]) {
      const result = await tool(svc).handler({ ...GOOD_INPUT, goal });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    // Nothing was created — validation is a pure pre-check.
    expect(svc.calls).toEqual([]);
  });

  it("rejects a non-string goal", async () => {
    const svc = services();
    const result = await tool(svc).handler({ ...GOOD_INPUT, goal: 42 });
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it("rejects repo_urls that aren't GitHub HTTPS", async () => {
    const svc = services();
    const bad = [
      "http://github.com/a/b", // wrong protocol — sandbox clones over https
      "https://gitlab.com/a/b", // wrong host
      "https://notgithub.com/a/b",
      "https://github.com.evil.example/a/b", // suffix-spoofed host
      "not a url at all",
      "",
      undefined,
    ];
    for (const repo_url of bad) {
      const result = await tool(svc).handler({ ...GOOD_INPUT, repo_url });
      expect(result.isError, `expected ${String(repo_url)} to be rejected`).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    }
    expect(svc.calls).toEqual([]);
  });

  it("accepts github.com and its subdomains", async () => {
    for (const repo_url of [
      "https://github.com/jsvine/pdfplumber",
      "https://www.github.com/jsvine/pdfplumber",
    ]) {
      const svc = services();
      const result = await tool(svc).handler({ ...GOOD_INPUT, repo_url });
      expect(result.isError).toBeFalsy();
    }
  });

  it("rejects an agent id that doesn't resolve", async () => {
    const svc = services();
    const result = await tool(svc, "agent_does_not_exist").handler(GOOD_INPUT);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // The lookup gates creation — no task should exist for a ghost caller.
    expect(svc.calls).toEqual([]);
  });
});

describe("use_repo — happy path", () => {
  it("returns the row ids, status and watch_url", async () => {
    const svc = services();
    const result = await tool(svc).handler(GOOD_INPUT);

    expect(result.isError).toBeFalsy();
    const body = result.content as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(body.repo_run_id).toMatch(/^repo_/);
    expect(body.session_id).toMatch(/^sess_/);
    expect(body.task_id).toBe(svc.created.task?.id);
    expect(body.watch_url).toBe(`/capabilities/runs/${String(body.repo_run_id)}`);
    // The anti-stampede hint — agents were re-calling use_repo in a loop.
    expect(String(body.note)).toMatch(/poll/i);
  });

  it("creates the session BEFORE the repo_run (FK ordering)", async () => {
    const svc = services();
    await tool(svc).handler(GOOD_INPUT);
    expect(svc.calls).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const svc = services();
    const result = await tool(svc).handler(GOOD_INPUT);
    const body = result.content as Record<string, unknown>;

    expect(svc.created.dispatch).toMatchObject({
      agentId: AGENT_ID,
      type: "run_repo",
      intent: GOOD_INPUT.goal,
      reason: { kind: "fresh" },
      sessionIdOverride: body.session_id,
    });
  });

  it("writes the repo_run keyed to that same session and task", async () => {
    const svc = services();
    const result = await tool(svc).handler(GOOD_INPUT);
    const body = result.content as Record<string, unknown>;

    expect(svc.created.repoRun).toMatchObject({
      id: body.repo_run_id,
      session_id: body.session_id,
      task_id: svc.created.task?.id,
      agent_id: AGENT_ID,
      goal: GOOD_INPUT.goal,
      repo_url: REPO,
      status: "pending",
    });
  });

  it("pins the container task to the resolved agent as both creator and assignee", async () => {
    const svc = services();
    await tool(svc).handler(GOOD_INPUT);
    expect(svc.created.task).toMatchObject({
      assignee_id: AGENT_ID,
      creator_id: AGENT_ID,
      creator_type: "agent",
      priority: "medium",
      description: GOOD_INPUT.goal,
    });
  });

  it("trims the goal and passes the trimmed form everywhere", async () => {
    const svc = services();
    await tool(svc).handler({ ...GOOD_INPUT, goal: "  do the thing  ", repo_url: `  ${REPO}  ` });
    expect(svc.created.task).toMatchObject({ description: "do the thing" });
    expect(svc.created.repoRun).toMatchObject({ goal: "do the thing", repo_url: REPO });
  });
});

describe("use_repo — container task title", () => {
  it("collapses whitespace so the inbox row stays scannable", async () => {
    const svc = services();
    await tool(svc).handler({ ...GOOD_INPUT, goal: "extract\n\n  tables   from\tthis PDF" });
    expect(svc.created.task?.title).toBe("extract tables from this PDF");
  });

  it("truncates a long goal to 77 chars plus an ellipsis", async () => {
    const svc = services();
    const goal = "x".repeat(200);
    await tool(svc).handler({ ...GOOD_INPUT, goal });
    expect(svc.created.task?.title).toBe(`${"x".repeat(77)}…`);
  });

  it("leaves a goal of exactly 80 chars intact", async () => {
    const svc = services();
    await tool(svc).handler({ ...GOOD_INPUT, goal: "y".repeat(80) });
    expect(svc.created.task?.title).toBe("y".repeat(80));
  });
});

describe("use_repo — limits clamping", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const svc = services();
    const result = await tool(svc).handler({ ...GOOD_INPUT, limits });
    return (result.content as { limits: Record<string, unknown> }).limits;
  }

  it("passes through in-range values", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 4096 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 4096 });
  });

  it("caps each limit at its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 999_999,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors fractional attempt and disk values", async () => {
    expect(await limitsFor({ max_install_attempts: 2.9, disk_mb: 100.7 })).toEqual({
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it("drops non-positive and non-numeric values rather than clamping them up", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      }),
    ).toEqual({});
  });

  it("returns {} for a missing or non-object limits field", async () => {
    for (const raw of [undefined, null, "nope", 7, []]) {
      expect(await limitsFor(raw)).toEqual({});
    }
  });
});

describe("use_repo — optional input file", () => {
  it("echoes a trimmed input_url and input_filename", async () => {
    const svc = services();
    const result = await tool(svc).handler({
      ...GOOD_INPUT,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(result.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves both undefined when not supplied or not strings", async () => {
    const svc = services();
    const result = await tool(svc).handler({ ...GOOD_INPUT, input_url: 5 });
    const body = result.content as Record<string, unknown>;
    expect(body.input_url).toBeUndefined();
    expect(body.input_filename).toBeUndefined();
  });
});

describe("use_repo — failure envelopes", () => {
  it("reports dispatch_failed and never inserts a repo_run", async () => {
    const svc = services({ dispatchThrows: new Error("no runtime online") });
    const result = await tool(svc).handler(GOOD_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(svc.calls).toEqual(["task.create", "dispatch"]);
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const svc = services({ dispatchThrows: "plain string blew up" });
    const result = await tool(svc).handler(GOOD_INPUT);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "plain string blew up",
    });
  });

  it("reports repo_run_create_failed when the row insert fails", async () => {
    const svc = services({ repoRunThrows: new Error("duplicate key") });
    const result = await tool(svc).handler(GOOD_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The session already landed; the orphan self-fails via
    // composeDispatchPayload, so the agent must see the error rather
    // than wait on a run that will never report.
    expect(svc.calls).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const svc = services({ repoRunThrows: { code: 23505 } });
    const result = await tool(svc).handler(GOOD_INPUT);
    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
  });
});

describe("use_repo — tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(services());
    expect(t.name).toBe("use_repo");
    expect(t.schema).toMatchObject({
      type: "object",
      required: ["goal", "repo_url"],
      additionalProperties: false,
    });
  });

  it("tells the agent sandboxed installs are not host installs", () => {
    // Agents were reporting "can't install yt-dlp" instead of calling
    // use_repo; the description carries that correction.
    expect(tool(services()).description).toMatch(/NOT system installs/);
  });

  it("mints a fresh session and repo_run id per call", async () => {
    const svc = services();
    const a = (await tool(svc).handler(GOOD_INPUT)).content as Record<string, unknown>;
    const b = (await tool(svc).handler(GOOD_INPUT)).content as Record<string, unknown>;
    expect(a.session_id).not.toBe(b.session_id);
    expect(a.repo_run_id).not.toBe(b.repo_run_id);
  });
});
