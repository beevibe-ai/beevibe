/**
 * use_repo handler tests.
 *
 * The handler is a four-step sequence with two failure seams that only
 * show up in production (dispatch throws, repo_run insert throws), so
 * they're driven here with fakes rather than left to the e2e script.
 * Ordering matters — repo_run.session_id has an FK to session.id, so
 * dispatch (which mints the session row) must land first; the last test
 * in the "happy path" block locks that.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

interface Harness {
  services: UseRepoServices;
  calls: string[];
  taskCreateInput: () => Record<string, unknown> | undefined;
  repoRunCreateInput: () => Record<string, unknown> | undefined;
  dispatchInput: () => Record<string, unknown> | undefined;
}

function harness(
  opts: {
    agent?: { id: string } | undefined;
    dispatchThrows?: Error;
    repoRunThrows?: Error;
  } = {},
): Harness {
  const calls: string[] = [];
  let taskInput: Record<string, unknown> | undefined;
  let repoRunInput: Record<string, unknown> | undefined;
  let dispatchArg: Record<string, unknown> | undefined;

  const agent = "agent" in opts ? opts.agent : { id: "agent_a" };

  const agentRepo = {
    findById: vi.fn(async () => {
      calls.push("agentRepo.findById");
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("taskRepo.create");
      taskInput = input;
      return { ...input, status: "pending" };
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("repoRunRepo.create");
      repoRunInput = input;
      if (opts.repoRunThrows) throw opts.repoRunThrows;
      return input;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("dispatchService.dispatchTask");
      dispatchArg = input;
      if (opts.dispatchThrows) throw opts.dispatchThrows;
      return {};
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    calls,
    taskCreateInput: () => taskInput,
    repoRunCreateInput: () => repoRunInput,
    dispatchInput: () => dispatchArg,
  };
}

function tool(h: Harness, agentId = "agent_a") {
  return createUseRepoTool({ agentId }, h.services);
}

const GOOD = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo — input validation", () => {
  it("rejects a missing goal before touching any repository", async () => {
    const h = harness();
    const result = await tool(h).handler({ repo_url: GOOD.repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.calls).toEqual([]);
  });

  it("rejects a whitespace-only goal", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: "   \n ", repo_url: GOOD.repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a URL at all", "jsvine/pdfplumber"],
    ["http, not https", "http://github.com/jsvine/pdfplumber"],
    ["a non-GitHub host", "https://gitlab.com/jsvine/pdfplumber"],
    // Substring match must not be enough — the hostname has to *end* in
    // github.com on a label boundary.
    ["a lookalike host", "https://notgithub.com/jsvine/pdfplumber"],
    ["github.com in the path only", "https://evil.example/github.com/x"],
  ])("rejects repo_url that is %s", async (_label, repoUrl) => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOOD.goal, repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.calls).toEqual([]);
  });

  it("accepts a github.com subdomain", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: GOOD.goal,
      repo_url: "https://www.github.com/jsvine/pdfplumber",
    });

    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller's agent row is gone", async () => {
    const h = harness({ agent: undefined });
    const result = await tool(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // Looked the agent up, then stopped — no task, no dispatch.
    expect(h.calls).toEqual(["agentRepo.findById"]);
  });
});

describe("use_repo — happy path", () => {
  it("returns the minted ids, a watch url, and a pending status", async () => {
    const h = harness();
    const result = await tool(h).handler(GOOD);

    expect(result.isError).toBeFalsy();
    const content = result.content as Record<string, string>;
    expect(content.status).toBe("pending");
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    expect(String(content.note)).toContain("Sandbox run started");
  });

  it("creates the container task assigned to and created by the calling agent", async () => {
    const h = harness();
    await tool(h).handler(GOOD);

    expect(h.taskCreateInput()).toMatchObject({
      title: GOOD.goal,
      description: GOOD.goal,
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });
  });

  it("collapses whitespace and truncates the container task title at 80 chars", async () => {
    const h = harness();
    const goal = "Extract   tables\nfrom " + "x".repeat(120);
    await tool(h).handler({ goal, repo_url: GOOD.repo_url });

    const title = String(h.taskCreateInput()?.title);
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Extract tables from ")).toBe(true);
  });

  it("keeps a title of exactly 80 chars intact", async () => {
    const h = harness();
    await tool(h).handler({ goal: "y".repeat(80), repo_url: GOOD.repo_url });

    expect(h.taskCreateInput()?.title).toBe("y".repeat(80));
  });

  it("dispatches a run_repo session pinned to the pre-minted session id", async () => {
    const h = harness();
    const result = await tool(h).handler(GOOD);

    const dispatched = h.dispatchInput();
    expect(dispatched).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
      sessionIdOverride: (result.content as Record<string, string>).session_id,
    });
    expect(dispatched?.task).toMatchObject({ id: h.taskCreateInput()?.id });
  });

  it("writes the repo_run row against the same session and task", async () => {
    const h = harness();
    const result = await tool(h).handler(GOOD);
    const content = result.content as Record<string, string>;

    expect(h.repoRunCreateInput()).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_a",
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  it("dispatches BEFORE inserting repo_run (repo_run.session_id FKs to session.id)", async () => {
    const h = harness();
    await tool(h).handler(GOOD);

    expect(h.calls).toEqual([
      "agentRepo.findById",
      "taskRepo.create",
      "dispatchService.dispatchTask",
      "repoRunRepo.create",
    ]);
  });

  it("trims the goal and repo_url before persisting them", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "  summarize the readme  ",
      repo_url: "  https://github.com/o/r  ",
    });

    expect(h.repoRunCreateInput()).toMatchObject({
      goal: "summarize the readme",
      repo_url: "https://github.com/o/r",
    });
  });
});

describe("use_repo — optional input passthrough", () => {
  it("echoes a trimmed input_url and input_filename", async () => {
    const h = harness();
    const result = await tool(h).handler({
      ...GOOD,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: " a.pdf ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves input_url and input_filename undefined when not supplied", async () => {
    const h = harness();
    const result = await tool(h).handler(GOOD);

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo — limit parsing", () => {
  async function limitsFor(limits: unknown) {
    const h = harness();
    const result = await tool(h).handler({ ...GOOD, limits });
    return result.content.limits;
  }

  it("passes sane limits through unchanged", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 });
  });

  it("caps each limit at its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors the integer-valued limits but not wall clock", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 1.5,
        max_install_attempts: 2.9,
        disk_mb: 100.7,
      }),
    ).toEqual({ wall_clock_minutes: 1.5, max_install_attempts: 2, disk_mb: 100 });
  });

  it("drops non-positive and non-numeric limits rather than passing them down", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "512",
      }),
    ).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a string", "20"],
    ["an empty object", {}],
  ])("returns {} when limits is %s", async (_label, raw) => {
    expect(await limitsFor(raw)).toEqual({});
  });
});

describe("use_repo — failure seams", () => {
  it("surfaces dispatch_failed and never writes repo_run", async () => {
    const h = harness({ dispatchThrows: new Error("no runtime online") });
    const result = await tool(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(h.calls).not.toContain("repoRunRepo.create");
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "boom" as unknown as Error });
    const result = await tool(h).handler(GOOD);

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("surfaces repo_run_create_failed rather than silently orphaning the session", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const result = await tool(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunThrows: 42 as unknown as Error });
    const result = await tool(h).handler(GOOD);

    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "42",
    });
  });
});

describe("use_repo — tool descriptor", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    expect(t.schema.additionalProperties).toBe(false);
  });

  it("advertises the three limit knobs the handler actually parses", () => {
    const t = tool(harness());
    const props = t.schema.properties as Record<string, { properties?: object }>;
    expect(Object.keys(props.limits?.properties ?? {}).sort()).toEqual([
      "disk_mb",
      "max_install_attempts",
      "wall_clock_minutes",
    ]);
  });
});
