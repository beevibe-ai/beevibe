import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import {
  createUseRepoTool,
  type UseRepoServices,
} from "./use-repo.js";

/**
 * `mock.calls[0][0]` is `T | undefined` under noUncheckedIndexedAccess;
 * every use here is guarded by an assertion that the call happened, so
 * read it through one helper rather than sprinkling non-null assertions.
 */
function firstArg<T>(fn: unknown): T {
  const calls = (fn as { mock: { calls: unknown[][] } }).mock.calls;
  if (calls.length === 0) throw new Error("expected the spy to have been called");
  return calls[0]![0] as T;
}

/**
 * use_repo is the Capability Network's verb (#149) — the handler owns
 * four things worth pinning down, none of which need a database:
 *
 *   1. input validation (goal, and GitHub-HTTPS-only repo_url)
 *   2. the container task's title shaping
 *   3. the dispatch-then-repo_run ORDER, which exists because
 *      repo_run.session_id has an FK to session.id
 *   4. limit clamping, which is the sandbox's only guard against an
 *      agent asking for a 10-hour / 1TB run
 *
 * Each failure mode returns a distinct `error` code the calling agent
 * branches on, so the codes are asserted literally.
 */

const AGENT_ID = "agent_caller";

function fakeAgentRepo(found = true): AgentRepository {
  return {
    findById: vi.fn(async (id: string) =>
      found && id === AGENT_ID
        ? ({ id: AGENT_ID, owner_id: "person_1", hierarchy_level: "ic" } as Agent)
        : undefined,
    ),
  } as unknown as AgentRepository;
}

function fakeTaskRepo(): TaskRepository {
  return {
    create: vi.fn(async (t: Partial<Task>) => ({ ...t }) as Task),
  } as unknown as TaskRepository;
}

function fakeRepoRunRepo(opts: { throws?: boolean } = {}): RepoRunRepository {
  return {
    create: vi.fn(async (r: Record<string, unknown>) => {
      if (opts.throws) throw new Error("repo_run insert exploded");
      return r;
    }),
  } as unknown as RepoRunRepository;
}

function fakeDispatchService(opts: { throws?: boolean } = {}): DispatchService {
  return {
    dispatchTask: vi.fn(async () => {
      if (opts.throws) throw new Error("no runtime online");
      return { sessionId: "sess_ignored" };
    }),
  } as unknown as DispatchService;
}

function services(over: Partial<UseRepoServices> = {}): UseRepoServices {
  return {
    agentRepo: fakeAgentRepo(),
    taskRepo: fakeTaskRepo(),
    repoRunRepo: fakeRepoRunRepo(),
    dispatchService: fakeDispatchService(),
    ...over,
  };
}

function tool(over: Partial<UseRepoServices> = {}) {
  const svc = services(over);
  return { t: createUseRepoTool({ agentId: AGENT_ID }, svc), svc };
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo — tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { t } = tool();
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    // additionalProperties:false matters — a typo'd key should be a
    // schema rejection at the MCP layer, not a silently ignored arg.
    expect(t.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo — goal validation", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   \n  "],
    ["not a string", 42],
  ])("rejects a %s goal", async (_label, goal) => {
    const { t, svc } = tool();
    const res = await t.handler({ ...OK_INPUT, goal });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    // Nothing should be created on a validation failure.
    expect(svc.taskRepo.create).not.toHaveBeenCalled();
    expect(svc.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("trims the goal before using it", async () => {
    const { t, svc } = tool();
    await t.handler({ ...OK_INPUT, goal: "  do the thing  " });
    expect(svc.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: "do the thing" }),
    );
  });
});

describe("use_repo — repo_url validation", () => {
  it.each([
    ["http (not https)", "http://github.com/foo/bar"],
    ["a non-GitHub host", "https://gitlab.com/foo/bar"],
    ["a lookalike host", "https://github.com.evil.test/foo/bar"],
    ["not a URL at all", "jsvine/pdfplumber"],
    ["empty", ""],
    ["not a string", 7],
    ["an ssh remote", "git@github.com:foo/bar.git"],
  ])("rejects %s", async (_label, repo_url) => {
    const { t, svc } = tool();
    const res = await t.handler({ ...OK_INPUT, repo_url });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(svc.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["apex github.com", "https://github.com/foo/bar"],
    ["a github.com subdomain", "https://www.github.com/foo/bar"],
    ["mixed case host", "https://GitHub.COM/foo/bar"],
  ])("accepts %s", async (_label, repo_url) => {
    const { t } = tool();
    const res = await t.handler({ ...OK_INPUT, repo_url });
    expect(res.isError).toBeUndefined();
  });
});

describe("use_repo — caller resolution", () => {
  it("fails with agent_not_found when the caller does not exist", async () => {
    const { t, svc } = tool({ agentRepo: fakeAgentRepo(false) });
    const res = await t.handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(svc.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo — container task", () => {
  it("pins creator + assignee to the resolved agent", async () => {
    const { t, svc } = tool();
    await t.handler(OK_INPUT);
    expect(svc.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee_id: AGENT_ID,
        creator_id: AGENT_ID,
        creator_type: "agent",
        priority: "medium",
      }),
    );
  });

  it("collapses whitespace in the title", async () => {
    const { t, svc } = tool();
    await t.handler({ ...OK_INPUT, goal: "extract\n\ttables   now" });
    const arg = firstArg<Partial<Task>>(svc.taskRepo.create);
    expect(arg.title).toBe("extract tables now");
  });

  it("truncates a long title to 80 chars with an ellipsis, keeping the full goal as description", async () => {
    const { t, svc } = tool();
    const goal = "x".repeat(200);
    await t.handler({ ...OK_INPUT, goal });
    const arg = firstArg<Partial<Task>>(svc.taskRepo.create);
    expect(arg.title).toHaveLength(78); // 77 chars + the 1-char ellipsis
    expect(arg.title!.endsWith("…")).toBe(true);
    expect(arg.description).toBe(goal);
  });

  it("leaves an exactly-80-char title untouched", async () => {
    const { t, svc } = tool();
    const goal = "y".repeat(80);
    await t.handler({ ...OK_INPUT, goal });
    const arg = firstArg<Partial<Task>>(svc.taskRepo.create);
    expect(arg.title).toBe(goal);
  });
});

describe("use_repo — dispatch ordering", () => {
  it("dispatches with a pre-minted session id, then inserts repo_run against it", async () => {
    const { t, svc } = tool();
    const res = await t.handler(OK_INPUT);

    const dispatchArg = firstArg<Record<string, unknown>>(
      svc.dispatchService.dispatchTask,
    );
    const runArg = firstArg<Record<string, unknown>>(svc.repoRunRepo.create);

    expect(dispatchArg.type).toBe("run_repo");
    expect(dispatchArg.intent).toBe(OK_INPUT.goal);
    expect(dispatchArg.agentId).toBe(AGENT_ID);
    expect(dispatchArg.reason).toEqual({ kind: "fresh" });

    // The FK on repo_run.session_id is why the session must exist first:
    // the id handed to dispatch is the same one stamped on the repo_run.
    expect(runArg.session_id).toBe(dispatchArg.sessionIdOverride);
    expect(res.content.session_id).toBe(dispatchArg.sessionIdOverride);
    expect(runArg.status).toBe("pending");
    expect(runArg.repo_url).toBe(OK_INPUT.repo_url);
  });

  it("returns dispatch_failed and never inserts repo_run when dispatch throws", async () => {
    const { t, svc } = tool({
      dispatchService: fakeDispatchService({ throws: true }),
    });
    const res = await t.handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("dispatch_failed");
    expect(res.content.message).toBe("no runtime online");
    expect(svc.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("surfaces repo_run_create_failed rather than silently leaving the agent waiting", async () => {
    const { t } = tool({ repoRunRepo: fakeRepoRunRepo({ throws: true }) });
    const res = await t.handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("repo_run_create_failed");
    expect(res.content.message).toBe("repo_run insert exploded");
  });
});

describe("use_repo — success envelope", () => {
  it("returns the ids, pending status and a watch_url pointing at the run", async () => {
    const { t, svc } = tool();
    const res = await t.handler(OK_INPUT);

    const runArg = firstArg<Record<string, unknown>>(svc.repoRunRepo.create);
    expect(res.isError).toBeUndefined();
    expect(res.content.repo_run_id).toBe(runArg.id);
    expect(res.content.status).toBe("pending");
    expect(res.content.watch_url).toBe(`/capabilities/runs/${runArg.id}`);
    expect(String(res.content.repo_run_id)).toMatch(/^repo_/);
    expect(String(res.content.session_id)).toMatch(/^sess_/);
  });

  it("passes input_url / input_filename back, trimmed", async () => {
    const { t } = tool();
    const res = await t.handler({
      ...OK_INPUT,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf ",
    });
    expect(res.content.input_url).toBe("https://example.test/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("omits input fields when they are absent or the wrong type", async () => {
    const { t } = tool();
    const res = await t.handler({ ...OK_INPUT, input_url: 5 });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo — limit clamping", () => {
  it("defaults to an empty limits object when absent or not an object", async () => {
    const { t } = tool();
    for (const limits of [undefined, null, "20", 20]) {
      const res = await t.handler({ ...OK_INPUT, limits });
      expect(res.content.limits).toEqual({});
    }
  });

  it("passes through in-range values", async () => {
    const { t } = tool();
    const res = await t.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 4096 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps each limit to its hard ceiling", async () => {
    const { t } = tool();
    const res = await t.handler({
      ...OK_INPUT,
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

  it("floors fractional attempt / disk values", async () => {
    const { t } = tool();
    const res = await t.handler({
      ...OK_INPUT,
      limits: { max_install_attempts: 2.9, disk_mb: 512.7 },
    });
    expect(res.content.limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric limits instead of honouring them", async () => {
    const { t } = tool();
    const res = await t.handler({
      ...OK_INPUT,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      },
    });
    expect(res.content.limits).toEqual({});
  });
});
