/**
 * use_repo — unit tests with vitest fakes (no DB, no Docker).
 *
 * The tool itself does no sandbox work; it validates input, mints three
 * ids and writes two rows in a specific order. That ordering is the
 * load-bearing part: `repo_run.session_id` has an FK to `session.id`,
 * so the dispatch (which creates the session row under our pre-minted
 * override) MUST land before the repo_run insert. A regression that
 * swaps them would fail only against a real Postgres, so it's pinned
 * here with a call-order assertion instead.
 *
 * The other things worth holding still: the two partial-failure
 * envelopes (session created but repo_run didn't), the limit clamps
 * that stop an agent asking for a 10-hour run, and the container-task
 * title truncation that keeps the inbox row scannable.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  NewRepoRun,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const AGENT_ID = "agent_caller";
const GOOD_URL = "https://github.com/acme/tool";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    owner_id: "person_owner",
    hierarchy_level: "ic",
    ...overrides,
  } as Agent;
}

/**
 * Builds the service bundle plus a shared `calls` log. Every fake
 * appends its name, so a test can assert the real sequence rather than
 * just that each dependency was touched.
 */
function makeServices(
  opts: {
    agent?: Agent | undefined;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const agent = "agent" in opts ? opts.agent : fakeAgent();

  const agentRepo = {
    findById: vi.fn(async () => {
      calls.push("agentRepo.findById");
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    // Echo the input back as a persisted row, which is what the real
    // repo does — the tool reads `containerTask.id` off the result.
    create: vi.fn(async (input: Partial<Task>) => {
      calls.push("taskRepo.create");
      return {
        status: "assigned",
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
        ...input,
      } as Task;
    }),
  } as unknown as TaskRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async () => {
      calls.push("dispatchService.dispatchTask");
      if (opts.dispatchThrows !== undefined) throw opts.dispatchThrows;
      return { sessionId: "ignored" };
    }),
  } as unknown as DispatchService;

  const repoRunRepo = {
    create: vi.fn(async (input: NewRepoRun) => {
      calls.push("repoRunRepo.create");
      if (opts.repoRunThrows !== undefined) throw opts.repoRunThrows;
      return input as never;
    }),
  } as unknown as RepoRunRepository;

  const services: UseRepoServices = {
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
  };
  return { services, calls, agentRepo, taskRepo, repoRunRepo, dispatchService };
}

function tool(services: UseRepoServices) {
  return createUseRepoTool({ agentId: AGENT_ID }, services);
}

// ── Shape ────────────────────────────────────────────────────────────────

describe("createUseRepoTool", () => {
  it("exposes the use_repo contract", () => {
    const { services } = makeServices();
    const t = tool(services);

    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    // additionalProperties:false is deliberate — it stops an agent
    // inventing params that would be silently dropped.
    expect(t.schema.additionalProperties).toBe(false);
  });
});

// ── Input validation (nothing is written) ────────────────────────────────

describe("use_repo input validation", () => {
  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["a non-string", 5],
    ["missing", undefined],
  ])("rejects a goal that is %s", async (_label, goal) => {
    const { services, calls } = makeServices();

    const res = await tool(services).handler({ goal, repo_url: GOOD_URL });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(calls).toEqual([]);
  });

  it.each([
    ["plain http", "http://github.com/acme/tool"],
    ["a non-GitHub host", "https://gitlab.com/acme/tool"],
    // Substring-only matches must not pass: the check anchors on the
    // hostname, so a lookalike domain is rejected.
    ["a lookalike host", "https://github.com.evil.test/acme/tool"],
    ["an ssh remote", "git@github.com:acme/tool.git"],
    ["unparseable", "not a url"],
    ["empty", ""],
    ["a non-string", 7],
  ])("rejects a repo_url that is %s", async (_label, repoUrl) => {
    const { services, calls } = makeServices();

    const res = await tool(services).handler({
      goal: "extract tables",
      repo_url: repoUrl,
    });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(calls).toEqual([]);
  });

  it.each([
    ["the bare host", "https://github.com/acme/tool"],
    ["a subdomain", "https://gist.github.com/acme/1234"],
    ["mixed case", "https://GitHub.com/acme/tool"],
  ])("accepts %s", async (_label, repoUrl) => {
    const { services } = makeServices();

    const res = await tool(services).handler({ goal: "g", repo_url: repoUrl });

    expect(res.isError).toBeUndefined();
  });

  it("checks the goal before the repo_url", async () => {
    const { services } = makeServices();

    const res = await tool(services).handler({ goal: "", repo_url: "nonsense" });

    expect(res.content.error).toBe("invalid_goal");
  });

  it("reports agent_not_found and writes nothing when the caller is unknown", async () => {
    const { services, calls } = makeServices({ agent: undefined });

    const res = await tool(services).handler({
      goal: "extract tables",
      repo_url: GOOD_URL,
    });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    // The lookup happened, but no rows were created.
    expect(calls).toEqual(["agentRepo.findById"]);
  });
});

// ── Happy path ───────────────────────────────────────────────────────────

describe("use_repo happy path", () => {
  it("creates the session row before the repo_run row (FK ordering)", async () => {
    const { services, calls } = makeServices();

    await tool(services).handler({ goal: "extract tables", repo_url: GOOD_URL });

    expect(calls).toEqual([
      "agentRepo.findById",
      "taskRepo.create",
      "dispatchService.dispatchTask",
      "repoRunRepo.create",
    ]);
  });

  it("pins the repo_run to the same session id it dispatched under", async () => {
    const { services, repoRunRepo, dispatchService } = makeServices();

    const res = await tool(services).handler({
      goal: "extract tables",
      repo_url: GOOD_URL,
    });

    const dispatched = vi.mocked(dispatchService.dispatchTask).mock.calls[0]![0];
    const run = vi.mocked(repoRunRepo.create).mock.calls[0]![0];

    expect(run.session_id).toBe(dispatched.sessionIdOverride);
    // …and the id the agent is handed back is the same one.
    expect(res.content.session_id).toBe(dispatched.sessionIdOverride);
    expect(res.content.repo_run_id).toBe(run.id);
  });

  it("dispatches a run_repo session carrying the goal as the intent", async () => {
    const { services, dispatchService, taskRepo } = makeServices();

    await tool(services).handler({ goal: "extract tables", repo_url: GOOD_URL });

    const created = vi.mocked(taskRepo.create).mock.calls[0]![0] as Task;
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        type: "run_repo",
        intent: "extract tables",
        reason: { kind: "fresh" },
        task: expect.objectContaining({ id: created.id }),
      }),
    );
  });

  it("pins the container task to the calling agent", async () => {
    const { services, taskRepo } = makeServices();

    await tool(services).handler({ goal: "extract tables", repo_url: GOOD_URL });

    expect(taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "extract tables",
        description: "extract tables",
        priority: "medium",
        assignee_id: AGENT_ID,
        creator_id: AGENT_ID,
        creator_type: "agent",
      }),
    );
  });

  it("writes the repo_run as pending with the caller's goal and url", async () => {
    const { services, repoRunRepo } = makeServices();

    await tool(services).handler({ goal: "extract tables", repo_url: GOOD_URL });

    expect(repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: AGENT_ID,
        goal: "extract tables",
        repo_url: GOOD_URL,
        status: "pending",
      }),
    );
  });

  it("returns the ids, a watch url and a don't-re-call note", async () => {
    const { services } = makeServices();

    const res = await tool(services).handler({
      goal: "  extract tables  ",
      repo_url: `  ${GOOD_URL}  `,
    });

    expect(res.isError).toBeUndefined();
    expect(res.content.status).toBe("pending");
    expect(res.content.watch_url).toBe(
      `/capabilities/runs/${res.content.repo_run_id as string}`,
    );
    expect(res.content.note).toMatch(/poll/i);
    // Both inputs were trimmed before use.
    expect(res.content.task_id).toBeTruthy();
  });

  it("trims the goal and url before persisting them", async () => {
    const { services, repoRunRepo } = makeServices();

    await tool(services).handler({
      goal: "  extract tables  ",
      repo_url: `  ${GOOD_URL}  `,
    });

    expect(repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "extract tables", repo_url: GOOD_URL }),
    );
  });

  it("mints a distinct id trio on each call", async () => {
    const { services } = makeServices();
    const t = tool(services);

    const a = await t.handler({ goal: "g", repo_url: GOOD_URL });
    const b = await t.handler({ goal: "g", repo_url: GOOD_URL });

    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
    expect(a.content.task_id).not.toBe(b.content.task_id);
  });
});

// ── Container task title ─────────────────────────────────────────────────

describe("container task title", () => {
  it("collapses internal whitespace so the inbox row stays on one line", async () => {
    const { services, taskRepo } = makeServices();

    await tool(services).handler({
      goal: "extract\n\ttables   from   the pdf",
      repo_url: GOOD_URL,
    });

    expect(taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "extract tables from the pdf" }),
    );
  });

  it("truncates a long goal to 77 chars plus an ellipsis", async () => {
    const { services, taskRepo } = makeServices();
    const goal = "x".repeat(200);

    await tool(services).handler({ goal, repo_url: GOOD_URL });

    const title = (vi.mocked(taskRepo.create).mock.calls[0]![0] as Task).title;
    // The cut is `slice(0, 77) + "…"`, so a truncated title is 78 chars —
    // comfortably under the 80 the >80 guard tests for, not equal to it.
    expect(title).toBe("x".repeat(77) + "…");
    expect(title).toHaveLength(78);
  });

  it("leaves an exactly-80-char goal untouched", async () => {
    const { services, taskRepo } = makeServices();
    const goal = "y".repeat(80);

    await tool(services).handler({ goal, repo_url: GOOD_URL });

    const title = (vi.mocked(taskRepo.create).mock.calls[0]![0] as Task).title;
    expect(title).toBe(goal);
    expect(title).not.toContain("…");
  });

  it("keeps the full goal as the description even when the title is cut", async () => {
    const { services, taskRepo } = makeServices();
    const goal = "z".repeat(200);

    await tool(services).handler({ goal, repo_url: GOOD_URL });

    const row = vi.mocked(taskRepo.create).mock.calls[0]![0] as Task;
    expect(row.description).toBe(goal);
  });
});

// ── Limits ───────────────────────────────────────────────────────────────

describe("use_repo limits", () => {
  async function limitsFor(raw: unknown): Promise<Record<string, unknown>> {
    const { services } = makeServices();
    const res = await tool(services).handler({
      goal: "g",
      repo_url: GOOD_URL,
      limits: raw,
    });
    return res.content.limits as Record<string, unknown>;
  }

  it("passes sane limits through unchanged", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 15,
        max_install_attempts: 3,
        disk_mb: 1024,
      }),
    ).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    // An agent asking for a 10-hour run gets an hour.
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 500_000,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    expect(
      await limitsFor({ max_install_attempts: 2.9, disk_mb: 100.7 }),
    ).toEqual({ max_install_attempts: 2, disk_mb: 100 });
  });

  it("keeps wall_clock_minutes fractional (it is not floored)", async () => {
    expect(await limitsFor({ wall_clock_minutes: 1.5 })).toEqual({
      wall_clock_minutes: 1.5,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a string", "20"],
    ["null", null],
  ])("drops a %s limit value", async (_label, value) => {
    expect(
      await limitsFor({
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      }),
    ).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a string", "big"],
    ["a number", 42],
  ])("returns an empty object when limits is %s", async (_label, raw) => {
    expect(await limitsFor(raw)).toEqual({});
  });

  it("ignores unknown limit keys", async () => {
    expect(await limitsFor({ cpu_cores: 32, wall_clock_minutes: 5 })).toEqual({
      wall_clock_minutes: 5,
    });
  });
});

// ── Sandbox input passthrough ────────────────────────────────────────────

describe("use_repo sandbox input", () => {
  it("echoes a trimmed input_url and input_filename", async () => {
    const { services } = makeServices();

    const res = await tool(services).handler({
      goal: "g",
      repo_url: GOOD_URL,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(res.content.input_url).toBe("https://example.test/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("leaves both undefined when not supplied", async () => {
    const { services } = makeServices();

    const res = await tool(services).handler({ goal: "g", repo_url: GOOD_URL });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });

  it("ignores non-string input fields", async () => {
    const { services } = makeServices();

    const res = await tool(services).handler({
      goal: "g",
      repo_url: GOOD_URL,
      input_url: 42,
      input_filename: { name: "x" },
    });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

// ── Failure paths ────────────────────────────────────────────────────────

describe("use_repo failure paths", () => {
  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const { services, calls, repoRunRepo } = makeServices({
      dispatchThrows: new Error("daemon offline"),
    });

    const res = await tool(services).handler({
      goal: "g",
      repo_url: GOOD_URL,
    });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(repoRunRepo.create).not.toHaveBeenCalled();
    expect(calls).not.toContain("repoRunRepo.create");
  });

  it("reports repo_run_create_failed when the orphan-session window loses", async () => {
    const { services } = makeServices({
      repoRunThrows: new Error("duplicate key"),
    });

    const res = await tool(services).handler({
      goal: "g",
      repo_url: GOOD_URL,
    });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it.each([
    ["dispatch", "dispatchThrows", "dispatch_failed"],
    ["repo_run insert", "repoRunThrows", "repo_run_create_failed"],
  ])("stringifies a non-Error thrown by %s", async (_label, key, code) => {
    const { services } = makeServices({ [key]: "boom" });

    const res = await tool(services).handler({
      goal: "g",
      repo_url: GOOD_URL,
    });

    expect(res.content).toEqual({ error: code, message: "boom" });
  });

  it("lets a taskRepo.create failure propagate (no envelope)", async () => {
    // There is no try/catch around the container-task insert: if the
    // task can't be created there's nothing to attach an artifact to,
    // so the throw is the honest signal rather than a silent envelope.
    const { services, taskRepo } = makeServices();
    vi.mocked(taskRepo.create).mockRejectedValueOnce(new Error("pg down"));

    await expect(
      tool(services).handler({ goal: "g", repo_url: GOOD_URL }),
    ).rejects.toThrow("pg down");
  });
});
