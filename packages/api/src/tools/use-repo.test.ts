/**
 * use_repo handler tests.
 *
 * The real run happens on the user's daemon inside Docker; what this
 * module owns is the pre-flight: validate the goal + repo URL, clamp
 * the limits, mint the container task, dispatch, then insert the
 * repo_run row. Order matters (repo_run.session_id FKs to session.id,
 * which dispatchTask creates), and each of the two failure points has
 * its own error code — those are what the fakes below pin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";
import type { AgentTool } from "./types.js";

type Mocked = Record<string, ReturnType<typeof vi.fn>>;

interface Harness {
  tool: AgentTool;
  agentRepo: Mocked;
  taskRepo: Mocked;
  repoRunRepo: Mocked;
  dispatchService: Mocked;
}

function harness(agentId = "agent_a"): Harness {
  const agentRepo: Mocked = {
    findById: vi.fn(async (id: string) => ({ id, name: "A" })),
  };
  const taskRepo: Mocked = {
    create: vi.fn(async (input: Record<string, unknown>) => ({ ...input })),
  };
  const repoRunRepo: Mocked = {
    create: vi.fn(async (input: Record<string, unknown>) => ({ ...input })),
  };
  const dispatchService: Mocked = { dispatchTask: vi.fn(async () => undefined) };

  const services = {
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
  } as unknown as UseRepoServices;

  return {
    tool: createUseRepoTool({ agentId }, services),
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
  };
}

const VALID = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool definition", () => {
  it("requires goal + repo_url and forbids extra properties", () => {
    const { tool } = harness();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo happy path", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("creates the container task, dispatches, then inserts repo_run", async () => {
    const res = await h.tool.handler(VALID);

    expect(res.isError).toBeUndefined();
    const task = h.taskRepo.create!.mock.calls[0]![0];
    expect(task.title).toBe(VALID.goal);
    expect(task.description).toBe(VALID.goal);
    expect(task.priority).toBe("medium");
    // Both sides of the container task point at the calling agent.
    expect(task.assignee_id).toBe("agent_a");
    expect(task.creator_id).toBe("agent_a");
    expect(task.creator_type).toBe("agent");

    const dispatch = h.dispatchService.dispatchTask!.mock.calls[0]![0];
    expect(dispatch.agentId).toBe("agent_a");
    expect(dispatch.type).toBe("run_repo");
    expect(dispatch.intent).toBe(VALID.goal);
    expect(dispatch.reason).toEqual({ kind: "fresh" });
    expect(dispatch.sessionIdOverride).toBe(res.content.session_id);

    const run = h.repoRunRepo.create!.mock.calls[0]![0];
    expect(run.id).toBe(res.content.repo_run_id);
    // The session row has to exist before the repo_run insert, so the
    // pre-minted id is what gets dispatched and what gets stored.
    expect(run.session_id).toBe(res.content.session_id);
    expect(run.task_id).toBe(task.id);
    expect(run.agent_id).toBe("agent_a");
    expect(run.goal).toBe(VALID.goal);
    expect(run.repo_url).toBe(VALID.repo_url);
    expect(run.status).toBe("pending");
  });

  it("returns the ids, status and a watch url the agent can poll", async () => {
    const res = await h.tool.handler(VALID);
    expect(res.content.repo_run_id).toMatch(/^repo_/);
    expect(res.content.session_id).toMatch(/^sess_/);
    expect(res.content.task_id).toBe(h.taskRepo.create!.mock.calls[0]![0].id);
    expect(res.content.status).toBe("pending");
    expect(res.content.watch_url).toBe(
      `/capabilities/runs/${res.content.repo_run_id}`,
    );
    expect(res.content.note).toMatch(/poll/i);
  });

  it("trims the goal and the repo url", async () => {
    await h.tool.handler({
      goal: "  tidy goal  ",
      repo_url: "  https://github.com/o/r  ",
    });
    expect(h.taskRepo.create!.mock.calls[0]![0].description).toBe("tidy goal");
    expect(h.repoRunRepo.create!.mock.calls[0]![0].repo_url).toBe(
      "https://github.com/o/r",
    );
  });

  it("echoes input_url / input_filename back, trimmed", async () => {
    const res = await h.tool.handler({
      ...VALID,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(res.content.input_url).toBe("https://example.com/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("leaves input_url / input_filename undefined when not strings", async () => {
    const res = await h.tool.handler({ ...VALID, input_url: 1, input_filename: {} });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });

  it("shortens an over-long goal for the container task title only", async () => {
    const goal = "x".repeat(200);
    const res = await h.tool.handler({ ...VALID, goal });
    const title = h.taskRepo.create!.mock.calls[0]![0].title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The full goal still reaches the description and the repo_run row.
    expect(h.taskRepo.create!.mock.calls[0]![0].description).toBe(goal);
    expect(h.repoRunRepo.create!.mock.calls[0]![0].goal).toBe(goal);
    expect(res.isError).toBeUndefined();
  });

  it("collapses whitespace in the title", async () => {
    await h.tool.handler({ ...VALID, goal: "do\n  this\tthing" });
    expect(h.taskRepo.create!.mock.calls[0]![0].title).toBe("do this thing");
  });
});

describe("use_repo input validation", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it.each([
    ["missing", {}],
    ["blank", { goal: "   " }],
    ["non-string", { goal: 7 }],
  ])("rejects a goal that is %s", async (_label, extra) => {
    const res = await h.tool.handler({ repo_url: VALID.repo_url, ...extra });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(h.agentRepo.findById).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["http, not https", "http://github.com/o/r"],
    ["not github", "https://gitlab.com/o/r"],
    ["a github lookalike host", "https://github.com.evil.test/o/r"],
    ["not a url at all", "github.com/o/r"],
    ["an ssh remote", "git@github.com:o/r.git"],
  ])("rejects a repo_url that is %s", async (_label, repoUrl) => {
    const res = await h.tool.handler({
      goal: VALID.goal,
      ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
    });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(h.taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/o/r",
    "https://www.github.com/o/r",
    "https://GitHub.com/o/r",
    "https://github.com/o/r/tree/main/sub",
  ])("accepts %s", async (repoUrl) => {
    const res = await h.tool.handler({ goal: VALID.goal, repo_url: repoUrl });
    expect(res.isError).toBeUndefined();
  });

  it("reports agent_not_found and creates nothing when the caller is unknown", async () => {
    h.agentRepo.findById!.mockResolvedValue(undefined);
    const res = await h.tool.handler(VALID);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(h.taskRepo.create).not.toHaveBeenCalled();
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });
});

describe("use_repo limit clamping", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("passes sane limits through unchanged", async () => {
    const res = await h.tool.handler({
      ...VALID,
      limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 1024 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const res = await h.tool.handler({
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

  it("floors the integer limits but leaves wall clock fractional", async () => {
    const res = await h.tool.handler({
      ...VALID,
      limits: { wall_clock_minutes: 1.5, max_install_attempts: 2.9, disk_mb: 100.7 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 1.5,
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it.each([
    ["absent", undefined],
    ["not an object", "20"],
    ["null", null],
    ["empty", {}],
  ])("yields no limits when the block is %s", async (_label, limits) => {
    const res = await h.tool.handler({
      ...VALID,
      ...(limits === undefined ? {} : { limits }),
    });
    expect(res.content.limits).toEqual({});
  });

  it("drops non-positive and non-numeric limit values", async () => {
    const res = await h.tool.handler({
      ...VALID,
      limits: { wall_clock_minutes: 0, max_install_attempts: -2, disk_mb: "2048" },
    });
    expect(res.content.limits).toEqual({});
  });
});

describe("use_repo failure paths", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("reports dispatch_failed and skips the repo_run insert", async () => {
    h.dispatchService.dispatchTask!.mockRejectedValue(new Error("no runtime online"));
    const res = await h.tool.handler(VALID);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(h.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    h.dispatchService.dispatchTask!.mockRejectedValue("nope");
    const res = await h.tool.handler(VALID);
    expect(res.content).toEqual({ error: "dispatch_failed", message: "nope" });
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan", async () => {
    h.repoRunRepo.create!.mockRejectedValue(new Error("duplicate key"));
    const res = await h.tool.handler(VALID);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The session was already created by dispatch — that's the orphan the
    // error code warns about.
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    h.repoRunRepo.create!.mockRejectedValue(404);
    const res = await h.tool.handler(VALID);
    expect(res.content).toEqual({ error: "repo_run_create_failed", message: "404" });
  });
});
