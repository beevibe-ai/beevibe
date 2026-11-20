/**
 * use_repo handler tests.
 *
 * The tool's job is a 4-step orchestration with ordering that matters:
 * validate → look the agent up → create the container task → dispatch
 * the session → insert the repo_run. `repo_run.session_id` carries an FK
 * to `session.id`, so the dispatch (which creates the session row under
 * a pre-minted id) has to land *before* the repo_run insert. These tests
 * pin that order explicitly, because getting it wrong produces an FK
 * violation only against a live Postgres — exactly the environment the
 * fast suite doesn't have.
 *
 * Also covered: the two mid-flight failure paths (dispatch throws,
 * repo_run insert throws) which each return a distinct error code, the
 * GitHub-URL guard, the `limits` clamping, and the container-task title
 * truncation.
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

const GOOD_URL = "https://github.com/pgvector/pgvector";

interface Harness {
  services: UseRepoServices;
  findById: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  createRepoRun: ReturnType<typeof vi.fn>;
  /** Call order across the three write steps, for FK-ordering assertions. */
  order: string[];
}

function harness(
  opts: {
    agent?: Agent | null;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const order: string[] = [];
  const agent =
    opts.agent === undefined
      ? ({ id: "agent_caller" } as unknown as Agent)
      : opts.agent;

  const findById = vi.fn(async () => agent);
  const createTask = vi.fn(async (input: { id: string; title: string }) => {
    order.push("task.create");
    return { ...input, status: "todo" } as unknown as Task;
  });
  const dispatchTask = vi.fn(async () => {
    order.push("dispatch");
    if (opts.dispatchThrows !== undefined) throw opts.dispatchThrows;
    return undefined;
  });
  const createRepoRun = vi.fn(async () => {
    order.push("repoRun.create");
    if (opts.repoRunThrows !== undefined) throw opts.repoRunThrows;
    return undefined;
  });

  const services = {
    agentRepo: { findById } as unknown as AgentRepository,
    taskRepo: { create: createTask } as unknown as TaskRepository,
    repoRunRepo: { create: createRepoRun } as unknown as RepoRunRepository,
    dispatchService: { dispatchTask } as unknown as DispatchService,
  };

  return { services, findById, createTask, dispatchTask, createRepoRun, order };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: "agent_caller" }, h.services);
}

describe("use_repo tool descriptor", () => {
  it("exposes the name and required inputs", () => {
    const h = harness();
    const t = tool(h);
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    expect(t.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects an empty goal before touching any service", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: "   ", repo_url: GOOD_URL });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "invalid_goal",
      message: "goal must be a non-empty string",
    });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it("rejects a missing goal", async () => {
    const h = harness();
    const result = await tool(h).handler({ repo_url: GOOD_URL });
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it("rejects a non-string goal", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: 42, repo_url: GOOD_URL });
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it.each([
    ["a missing url", undefined],
    ["an empty url", "  "],
    ["a non-string url", 7],
    ["plain http", "http://github.com/a/b"],
    ["a non-GitHub host", "https://gitlab.com/a/b"],
    // The guard is an exact host match on github.com (or a subdomain),
    // so a lookalike domain that merely *contains* it must not pass.
    ["a lookalike host", "https://github.com.evil.test/a/b"],
    ["an ssh-style ref", "git@github.com:a/b.git"],
    ["garbage", "not a url at all"],
  ])("rejects %s", async (_label, repoUrl) => {
    const h = harness();
    const result = await tool(h).handler({ goal: "do it", repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "invalid_repo_url",
      message: "repo_url must be a GitHub HTTPS URL",
    });
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ["bare github.com", "https://github.com/a/b"],
    ["a www subdomain", "https://www.github.com/a/b"],
    ["mixed case host", "https://GitHub.COM/a/b"],
  ])("accepts %s", async (_label, repoUrl) => {
    const h = harness();
    const result = await tool(h).handler({ goal: "do it", repo_url: repoUrl });
    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const h = harness({ agent: null });
    const result = await tool(h).handler({ goal: "do it", repo_url: GOOD_URL });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "agent_not_found",
      message: "calling agent not found",
    });
    // Nothing was written — the lookup gates the whole write sequence.
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.dispatchTask).not.toHaveBeenCalled();
    expect(h.createRepoRun).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("creates the task, dispatches, then inserts the repo_run — in that order", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "Extract tables from this PDF as JSON",
      repo_url: GOOD_URL,
    });

    expect(result.isError).toBeFalsy();
    // repo_run.session_id FKs to session.id, which dispatch creates.
    expect(h.order).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("returns the minted ids, status and watch url", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "Extract tables",
      repo_url: GOOD_URL,
    });

    const c = result.content as Record<string, string>;
    expect(c.status).toBe("pending");
    expect(typeof c.repo_run_id).toBe("string");
    expect(typeof c.session_id).toBe("string");
    expect(typeof c.task_id).toBe("string");
    // The UI route is built from the repo_run id, not the session id.
    expect(c.watch_url).toBe(`/capabilities/runs/${c.repo_run_id}`);
    expect(c.note).toContain("Sandbox run started");
  });

  it("dispatches a run_repo session under the same id it reports back", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "Extract tables",
      repo_url: GOOD_URL,
    });
    const reportedSessionId = (result.content as { session_id: string })
      .session_id;

    expect(h.dispatchTask).toHaveBeenCalledTimes(1);
    const dispatched = h.dispatchTask.mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: "Extract tables",
      reason: { kind: "fresh" },
      sessionIdOverride: reportedSessionId,
    });
  });

  it("inserts the repo_run against the dispatched session and container task", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "Extract tables",
      repo_url: GOOD_URL,
    });
    const c = result.content as Record<string, string>;

    expect(h.createRepoRun).toHaveBeenCalledWith({
      id: c.repo_run_id,
      session_id: c.session_id,
      task_id: c.task_id,
      agent_id: "agent_caller",
      goal: "Extract tables",
      repo_url: GOOD_URL,
      status: "pending",
    });
  });

  it("pins the container task to the resolved agent as both creator and assignee", async () => {
    const h = harness();
    await tool(h).handler({ goal: "Extract tables", repo_url: GOOD_URL });

    expect(h.createTask.mock.calls[0]?.[0]).toMatchObject({
      title: "Extract tables",
      description: "Extract tables",
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });
  });

  it("trims the goal before storing and dispatching it", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "  padded goal  ",
      repo_url: `  ${GOOD_URL}  `,
    });

    expect(h.createTask.mock.calls[0]?.[0]).toMatchObject({
      description: "padded goal",
    });
    expect(h.createRepoRun.mock.calls[0]?.[0]).toMatchObject({
      goal: "padded goal",
      repo_url: GOOD_URL,
    });
  });

  it("mints a distinct repo_run, session and task id per call", async () => {
    const h = harness();
    const a = (
      await tool(h).handler({ goal: "one", repo_url: GOOD_URL })
    ).content as Record<string, string>;
    const b = (
      await tool(h).handler({ goal: "two", repo_url: GOOD_URL })
    ).content as Record<string, string>;

    expect(a.repo_run_id).not.toBe(b.repo_run_id);
    expect(a.session_id).not.toBe(b.session_id);
    expect(a.task_id).not.toBe(b.task_id);
  });
});

describe("use_repo container task title", () => {
  it("collapses whitespace runs so the inbox row stays scannable", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "extract\n\n  tables   from\tthe pdf",
      repo_url: GOOD_URL,
    });
    expect(h.createTask.mock.calls[0]?.[0].title).toBe(
      "extract tables from the pdf",
    );
    // The description keeps the agent's original prose.
    expect(h.createTask.mock.calls[0]?.[0].description).toBe(
      "extract\n\n  tables   from\tthe pdf",
    );
  });

  it("truncates a long goal to 77 chars plus an ellipsis", async () => {
    const h = harness();
    const goal = "x".repeat(200);
    await tool(h).handler({ goal, repo_url: GOOD_URL });

    // The threshold is >80 but the cut is slice(0, 77) + "…", so a
    // truncated title is 78 chars, not 80. Asserted as-is: it's a
    // cosmetic inbox label, and pinning the real number keeps this test
    // honest rather than encoding the rounder-looking intent.
    const title = h.createTask.mock.calls[0]?.[0].title as string;
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
    expect(title.slice(0, 77)).toBe("x".repeat(77));
  });

  it("leaves a goal of exactly 80 chars untruncated", async () => {
    const h = harness();
    await tool(h).handler({ goal: "y".repeat(80), repo_url: GOOD_URL });
    expect(h.createTask.mock.calls[0]?.[0].title).toBe("y".repeat(80));
  });
});

describe("use_repo limits parsing", () => {
  async function limitsFor(raw: unknown) {
    const h = harness();
    const result = await tool(h).handler({
      goal: "do it",
      repo_url: GOOD_URL,
      limits: raw,
    });
    return (result.content as { limits: Record<string, number> }).limits;
  }

  it("passes sane values through", async () => {
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
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 999_999,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    expect(
      await limitsFor({ max_install_attempts: 2.9, disk_mb: 512.7 }),
    ).toEqual({ max_install_attempts: 2, disk_mb: 512 });
  });

  it("drops non-positive values so defaults apply downstream", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: -5,
      }),
    ).toEqual({});
  });

  it("drops non-numeric values", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: "20", disk_mb: null }),
    ).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a non-object", "lots"],
  ])("returns an empty object when limits is %s", async (_label, raw) => {
    expect(await limitsFor(raw)).toEqual({});
  });
});

describe("use_repo input_url passthrough", () => {
  it("echoes a trimmed input_url and filename", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "extract",
      repo_url: GOOD_URL,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.test/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves both undefined when not supplied", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "extract",
      repo_url: GOOD_URL,
    });
    const c = result.content as Record<string, unknown>;
    expect(c.input_url).toBeUndefined();
    expect(c.input_filename).toBeUndefined();
  });

  it("ignores non-string input_url / input_filename", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "extract",
      repo_url: GOOD_URL,
      input_url: 5,
      input_filename: false,
    });
    const c = result.content as Record<string, unknown>;
    expect(c.input_url).toBeUndefined();
    expect(c.input_filename).toBeUndefined();
  });
});

describe("use_repo failure paths", () => {
  it("reports dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const h = harness({ dispatchThrows: new Error("no daemon online") });
    const result = await tool(h).handler({
      goal: "extract",
      repo_url: GOOD_URL,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    // Critical: no orphan repo_run row pointing at a session that was
    // never created.
    expect(h.createRepoRun).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "queue closed" });
    const result = await tool(h).handler({
      goal: "extract",
      repo_url: GOOD_URL,
    });
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "queue closed",
    });
  });

  it("reports repo_run_create_failed when the insert throws after dispatch", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const result = await tool(h).handler({
      goal: "extract",
      repo_url: GOOD_URL,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The session was already dispatched; the handler surfaces the error
    // rather than leaving the agent waiting on a run that can't compose.
    expect(h.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunThrows: { code: "23503" } });
    const result = await tool(h).handler({
      goal: "extract",
      repo_url: GOOD_URL,
    });
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "[object Object]",
    });
  });
});
