/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler's job is validation plus a three-step write with a
 * documented ordering constraint: container task → session (via
 * dispatchService, under a pre-minted id) → repo_run, because
 * `repo_run.session_id` has an FK to `session.id`. The tests pin that
 * order, the id threading between the three rows, and the two failure
 * windows (dispatch throws, repo_run insert throws after the session
 * landed) — the second is the orphan-session path the comment in the
 * source calls out as self-recovering but agent-visible.
 *
 * `isLikelyGithubUrl` and `parseLimits` are private, so they're
 * exercised through the handler.
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

const AGENT = "agent_a";
const GOOD_URL = "https://github.com/acme/pdf-tables";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Ada",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_container1",
    title: "extract the tables",
    status: "pending",
    priority: "medium",
    creator_id: AGENT,
    creator_type: "agent",
    created_at: new Date("2026-05-01"),
    updated_at: new Date("2026-05-01"),
    ...overrides,
  };
}

interface Harness {
  services: UseRepoServices;
  order: string[];
}

function makeServices(
  opts: {
    agent?: Agent | undefined;
    taskCreate?: TaskRepository["create"];
    dispatchTask?: DispatchService["dispatchTask"];
    repoRunCreate?: RepoRunRepository["create"];
  } = {},
): Harness {
  const order: string[] = [];
  const task = fakeTask();
  const agentRepo = {
    findById: vi.fn(async () => ("agent" in opts ? opts.agent : fakeAgent())),
  } as unknown as AgentRepository;
  const taskRepo = {
    create:
      opts.taskCreate ??
      (vi.fn(async () => {
        order.push("task");
        return task;
      }) as unknown as TaskRepository["create"]),
  } as unknown as TaskRepository;
  const dispatchService = {
    dispatchTask:
      opts.dispatchTask ??
      (vi.fn(async () => {
        order.push("dispatch");
        return { session: { id: "sess_x" }, runtime_id: null };
      }) as unknown as DispatchService["dispatchTask"]),
  } as unknown as DispatchService;
  const repoRunRepo = {
    create:
      opts.repoRunCreate ??
      (vi.fn(async () => {
        order.push("repo_run");
        return {} as RepoRun;
      }) as unknown as RepoRunRepository["create"]),
  } as unknown as RepoRunRepository;
  return { services: { agentRepo, taskRepo, repoRunRepo, dispatchService }, order };
}

function makeTool(h: Harness) {
  return createUseRepoTool({ agentId: AGENT }, h.services);
}

describe("createUseRepoTool", () => {
  it("exposes the use_repo name, schema and required fields", () => {
    const tool = makeTool(makeServices());
    expect(tool.name).toBe("use_repo");
    expect(tool.schema).toMatchObject({ type: "object", required: ["goal", "repo_url"] });
    // The description is the agent-facing contract; the "sandboxed
    // installs aren't system installs" carve-out is the whole reason an
    // agent reaches for this instead of reporting an install blocker.
    expect(tool.description).toContain("use_repo");
    expect(tool.description).toContain("sandbox");
  });
});

describe("use_repo validation", () => {
  it("rejects a missing, blank or non-string goal before touching any repo", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    for (const input of [
      { repo_url: GOOD_URL },
      { goal: "   ", repo_url: GOOD_URL },
      { goal: 42, repo_url: GOOD_URL },
    ]) {
      const res = await tool.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(h.services.agentRepo.findById).not.toHaveBeenCalled();
    expect(h.services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("rejects anything that isn't an https github.com URL", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    const bad = [
      undefined,
      "",
      "   ",
      "not a url",
      // http, not https.
      "http://github.com/acme/tool",
      // Other hosts, including a lookalike that only ends with the name.
      "https://gitlab.com/acme/tool",
      "https://notgithub.com/acme/tool",
      "https://github.com.evil.example/acme/tool",
      "git@github.com:acme/tool.git",
    ];
    for (const repo_url of bad) {
      const res = await tool.handler({ goal: "do the thing", ...(repo_url === undefined ? {} : { repo_url }) });
      expect(res.isError, `expected ${String(repo_url)} to be rejected`).toBe(true);
      expect(res.content).toMatchObject({ error: "invalid_repo_url" });
    }
    expect(h.services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a github.com subdomain and trims surrounding whitespace", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    const res = await tool.handler({
      goal: "  extract tables  ",
      repo_url: `  ${GOOD_URL}  `,
    });
    expect(res.isError).toBeUndefined();
    expect(vi.mocked(h.services.repoRunRepo.create).mock.calls[0]?.[0]).toMatchObject({
      goal: "extract tables",
      repo_url: GOOD_URL,
    });

    const sub = await tool.handler({ goal: "g", repo_url: "https://www.github.com/acme/tool" });
    expect(sub.isError).toBeUndefined();
  });

  it("reports agent_not_found when the caller's row is gone", async () => {
    const h = makeServices({ agent: undefined });
    const tool = makeTool(h);

    const res = await tool.handler({ goal: "do it", repo_url: GOOD_URL });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "agent_not_found" });
    expect(h.services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("writes task → session → repo_run in that order with threaded ids", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    const res = await tool.handler({ goal: "extract the tables", repo_url: GOOD_URL });
    expect(res.isError).toBeUndefined();
    // repo_run.session_id FKs to session.id, so the session has to land first.
    expect(h.order).toEqual(["task", "dispatch", "repo_run"]);

    const taskArg = vi.mocked(h.services.taskRepo.create).mock.calls[0]![0];
    expect(taskArg).toMatchObject({
      title: "extract the tables",
      description: "extract the tables",
      priority: "medium",
      assignee_id: AGENT,
      creator_id: AGENT,
      creator_type: "agent",
    });

    const dispatchArg = vi.mocked(h.services.dispatchService.dispatchTask).mock.calls[0]![0];
    expect(dispatchArg).toMatchObject({
      agentId: AGENT,
      type: "run_repo",
      intent: "extract the tables",
      reason: { kind: "fresh" },
    });

    const runArg = vi.mocked(h.services.repoRunRepo.create).mock.calls[0]![0];
    expect(runArg).toMatchObject({
      task_id: "task_container1",
      agent_id: AGENT,
      goal: "extract the tables",
      repo_url: GOOD_URL,
      status: "pending",
    });
    // The pre-minted session id is what ties the two rows together.
    expect(runArg.session_id).toBe(
      (dispatchArg as { sessionIdOverride: string }).sessionIdOverride,
    );
    expect(res.content).toMatchObject({
      repo_run_id: runArg.id,
      session_id: runArg.session_id,
      task_id: "task_container1",
      status: "pending",
      watch_url: `/capabilities/runs/${runArg.id}`,
    });
    expect(res.content.note).toContain("repo_run.status");
  });

  it("mints a fresh id pair per call", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    const a = await tool.handler({ goal: "one", repo_url: GOOD_URL });
    const b = await tool.handler({ goal: "two", repo_url: GOOD_URL });
    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
  });

  it("collapses whitespace and truncates a long goal into the task title", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    await tool.handler({ goal: "extract\n  the\ttables", repo_url: GOOD_URL });
    expect(vi.mocked(h.services.taskRepo.create).mock.calls[0]![0].title).toBe(
      "extract the tables",
    );

    await tool.handler({ goal: "z".repeat(200), repo_url: GOOD_URL });
    const long = vi.mocked(h.services.taskRepo.create).mock.calls[1]![0].title;
    expect(long).toHaveLength(78);
    expect(long.endsWith("…")).toBe(true);
    // The full goal still reaches the description and the repo_run row.
    expect(vi.mocked(h.services.taskRepo.create).mock.calls[1]![0].description).toHaveLength(200);
  });

  it("echoes the optional input_url / input_filename back, trimmed", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    const res = await tool.handler({
      goal: "extract",
      repo_url: GOOD_URL,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(res.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });

    const none = await tool.handler({ goal: "extract", repo_url: GOOD_URL, input_url: 7 });
    expect(none.content.input_url).toBeUndefined();
    expect(none.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limits", () => {
  it("passes sane limits through untouched", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    const res = await tool.handler({
      goal: "extract",
      repo_url: GOOD_URL,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 4096 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    const res = await tool.handler({
      goal: "extract",
      repo_url: GOOD_URL,
      limits: { wall_clock_minutes: 999, max_install_attempts: 99, disk_mb: 999_999 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional counts, and drops non-positive or non-numeric values", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    const floored = await tool.handler({
      goal: "extract",
      repo_url: GOOD_URL,
      limits: { max_install_attempts: 2.9, disk_mb: 512.7 },
    });
    expect(floored.content.limits).toEqual({ max_install_attempts: 2, disk_mb: 512 });

    const dropped = await tool.handler({
      goal: "extract",
      repo_url: GOOD_URL,
      limits: { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: "lots" },
    });
    expect(dropped.content.limits).toEqual({});
  });

  it("treats a missing or non-object limits field as no limits", async () => {
    const h = makeServices();
    const tool = makeTool(h);

    for (const limits of [undefined, null, "none", 42]) {
      const res = await tool.handler({
        goal: "extract",
        repo_url: GOOD_URL,
        ...(limits === undefined ? {} : { limits }),
      });
      expect(res.content.limits).toEqual({});
    }
  });
});

describe("use_repo failure windows", () => {
  it("reports dispatch_failed and never inserts a repo_run", async () => {
    const h = makeServices({
      dispatchTask: vi.fn(async () => {
        throw new Error("no runtime bound");
      }) as unknown as DispatchService["dispatchTask"],
    });
    const tool = makeTool(h);

    const res = await tool.handler({ goal: "extract", repo_url: GOOD_URL });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime bound",
    });
    expect(h.services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("reports repo_run_create_failed when the session landed but the run row didn't", async () => {
    const h = makeServices({
      repoRunCreate: vi.fn(async () => {
        throw new Error("duplicate key");
      }) as unknown as RepoRunRepository["create"],
    });
    const tool = makeTool(h);

    const res = await tool.handler({ goal: "extract", repo_url: GOOD_URL });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The orphan session is left for composeDispatchPayload to fail.
    expect(h.services.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error throw from either write", async () => {
    const dispatch = makeServices({
      dispatchTask: vi.fn(async () => {
        throw "pool exhausted";
      }) as unknown as DispatchService["dispatchTask"],
    });
    const a = await makeTool(dispatch).handler({ goal: "g", repo_url: GOOD_URL });
    expect(a.content).toMatchObject({ error: "dispatch_failed", message: "pool exhausted" });

    const run = makeServices({
      repoRunCreate: vi.fn(async () => {
        throw { code: "23505" };
      }) as unknown as RepoRunRepository["create"],
    });
    const b = await makeTool(run).handler({ goal: "g", repo_url: GOOD_URL });
    expect(b.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof b.content.message).toBe("string");
  });

  it("lets a container-task insert failure propagate (no silent swallow)", async () => {
    const h = makeServices({
      taskCreate: vi.fn(async () => {
        throw new Error("task insert failed");
      }) as unknown as TaskRepository["create"],
    });
    const tool = makeTool(h);

    await expect(tool.handler({ goal: "extract", repo_url: GOOD_URL })).rejects.toThrow(
      "task insert failed",
    );
    expect(h.services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });
});
