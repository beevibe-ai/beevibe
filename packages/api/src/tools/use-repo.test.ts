/**
 * `use_repo` MCP tool — unit tests with vitest fakes.
 *
 * The handler is a four-step sequence with a bail-out at each step:
 * validate → resolve the caller → create the container task → dispatch
 * the sandbox session → insert the repo_run row. Two of those steps can
 * fail after side effects have already landed, and the ordering
 * (session row before repo_run, because of the FK) is load-bearing, so
 * the tests pin the call order as well as the responses.
 *
 * The limit clamps are the other half: they're the only thing stopping
 * a hallucinated `disk_mb: 999999` from reaching the sandbox runner.
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

const AGENT = "agent_caller0001";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Sandbox Caller",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function makeServices(overrides: Partial<UseRepoServices> = {}): UseRepoServices {
  return {
    agentRepo: { findById: vi.fn(async () => fakeAgent()) } as unknown as AgentRepository,
    taskRepo: {
      create: vi.fn(async (input: Partial<Task>) => ({ ...input }) as Task),
    } as unknown as TaskRepository,
    repoRunRepo: { create: vi.fn(async () => undefined) } as unknown as RepoRunRepository,
    dispatchService: {
      dispatchTask: vi.fn(async () => ({ session: { id: "sess_x" }, runtime_id: null })),
    } as unknown as DispatchService,
    ...overrides,
  };
}

function makeTool(services = makeServices()) {
  return { tool: createUseRepoTool({ agentId: AGENT }, services), services };
}

const VALID = { goal: "extract the tables", repo_url: "https://github.com/acme/pdf-tools" };

describe("use_repo tool metadata", () => {
  it("advertises the required inputs so MCP clients can validate ahead of the call", () => {
    const { tool } = makeTool();

    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing or whitespace-only goal before touching any repo", async () => {
    const { tool, services } = makeTool();

    const missing = await tool.handler({ repo_url: VALID.repo_url });
    const blank = await tool.handler({ goal: "   ", repo_url: VALID.repo_url });

    for (const res of [missing, blank]) {
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("invalid_goal");
    }
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects anything that isn't an https github.com URL", async () => {
    const { tool, services } = makeTool();
    const bad = [
      undefined,
      "",
      "  ",
      "not a url",
      "http://github.com/acme/tool", // plaintext
      "https://gitlab.com/acme/tool", // wrong host
      "https://github.com.evil.example/acme/tool", // suffix spoof
      "ftp://github.com/acme/tool",
    ];

    for (const repo_url of bad) {
      const res = await tool.handler({ goal: VALID.goal, repo_url });
      expect(res.isError, `expected ${String(repo_url)} to be rejected`).toBe(true);
      expect(res.content.error).toBe("invalid_repo_url");
    }
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("accepts github.com subdomains and trims surrounding whitespace", async () => {
    const { tool, services } = makeTool();

    const res = await tool.handler({
      goal: "  extract the tables  ",
      repo_url: "  https://www.github.com/acme/pdf-tools  ",
    });

    expect(res.isError).toBeFalsy();
    expect(vi.mocked(services.repoRunRepo.create).mock.calls[0]?.[0]).toMatchObject({
      goal: "extract the tables",
      repo_url: "https://www.github.com/acme/pdf-tools",
    });
  });

  it("errors when the calling agent no longer exists", async () => {
    const services = makeServices();
    vi.mocked(services.agentRepo.findById).mockResolvedValue(undefined);
    const { tool } = makeTool(services);

    const res = await tool.handler(VALID);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("creates a container task, dispatches the session, then inserts the repo_run", async () => {
    const { tool, services } = makeTool();

    const res = await tool.handler(VALID);

    expect(res.isError).toBeFalsy();
    const taskInput = vi.mocked(services.taskRepo.create).mock.calls[0]?.[0];
    expect(taskInput).toMatchObject({
      title: "extract the tables",
      description: "extract the tables",
      assignee_id: AGENT,
      creator_id: AGENT,
      creator_type: "agent",
      priority: "medium",
    });

    const dispatchInput = vi.mocked(services.dispatchService.dispatchTask).mock.calls[0]?.[0];
    expect(dispatchInput).toMatchObject({
      agentId: AGENT,
      type: "run_repo",
      intent: "extract the tables",
      reason: { kind: "fresh" },
    });

    // The FK on repo_run.session_id means the session must exist first:
    // the pre-minted id is what ties the two inserts together.
    const runInput = vi.mocked(services.repoRunRepo.create).mock.calls[0]?.[0];
    expect(runInput?.session_id).toBe(dispatchInput?.sessionIdOverride);
    expect(runInput).toMatchObject({
      agent_id: AGENT,
      repo_url: VALID.repo_url,
      status: "pending",
    });

    expect(res.content).toMatchObject({
      repo_run_id: runInput?.id,
      session_id: runInput?.session_id,
      task_id: taskInput?.id,
      status: "pending",
      watch_url: `/capabilities/runs/${runInput?.id}`,
    });
  });

  it("mints fresh ids on every call", async () => {
    const { tool } = makeTool();

    const first = await tool.handler(VALID);
    const second = await tool.handler(VALID);

    expect(first.content.repo_run_id).not.toBe(second.content.repo_run_id);
    expect(first.content.session_id).not.toBe(second.content.session_id);
  });

  it("collapses whitespace and truncates a long goal into the task title", async () => {
    const { tool, services } = makeTool();

    await tool.handler({ ...VALID, goal: `${"a".repeat(200)}\n\n  b` });

    const title = vi.mocked(services.taskRepo.create).mock.calls[0]?.[0].title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
  });

  it("keeps a short goal as the title verbatim", async () => {
    const { tool, services } = makeTool();

    await tool.handler({ ...VALID, goal: "  pull   the  audio track " });

    expect(vi.mocked(services.taskRepo.create).mock.calls[0]?.[0].title).toBe(
      "pull the audio track",
    );
  });

  it("echoes the optional input download hints back to the caller", async () => {
    const { tool } = makeTool();

    const res = await tool.handler({
      ...VALID,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(res.content.input_url).toBe("https://example.com/report.pdf");
    expect(res.content.input_filename).toBe("report.pdf");
  });

  it("leaves the input hints undefined when they aren't strings", async () => {
    const { tool } = makeTool();

    const res = await tool.handler({ ...VALID, input_url: 42, input_filename: null });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limit parsing", () => {
  it("passes sane limits through untouched", async () => {
    const { tool } = makeTool();

    const res = await tool.handler({
      ...VALID,
      limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 4096 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps oversized limits to the ceilings", async () => {
    const { tool } = makeTool();

    const res = await tool.handler({
      ...VALID,
      limits: { wall_clock_minutes: 9999, max_install_attempts: 99, disk_mb: 999_999 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional counts so the sandbox runner gets integers", async () => {
    const { tool } = makeTool();

    const res = await tool.handler({
      ...VALID,
      limits: { max_install_attempts: 2.9, disk_mb: 1024.7 },
    });

    expect(res.content.limits).toEqual({ max_install_attempts: 2, disk_mb: 1024 });
  });

  it("drops non-positive and non-numeric limits rather than passing junk down", async () => {
    const { tool } = makeTool();

    const res = await tool.handler({
      ...VALID,
      limits: { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: "2048" },
    });

    expect(res.content.limits).toEqual({});
  });

  it("treats a missing or non-object `limits` as no limits", async () => {
    const { tool } = makeTool();

    const omitted = await tool.handler(VALID);
    const wrongType = await tool.handler({ ...VALID, limits: "20 minutes" });
    const nulled = await tool.handler({ ...VALID, limits: null });

    for (const res of [omitted, wrongType, nulled]) {
      expect(res.content.limits).toEqual({});
    }
  });
});

describe("use_repo failure handling", () => {
  it("surfaces a dispatch failure without attempting the repo_run insert", async () => {
    const services = makeServices();
    vi.mocked(services.dispatchService.dispatchTask).mockRejectedValue(
      new Error("no runtime bound"),
    );
    const { tool } = makeTool(services);

    const res = await tool.handler(VALID);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime bound",
    });
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("surfaces the orphaned-session case when the repo_run insert fails", async () => {
    const services = makeServices();
    vi.mocked(services.repoRunRepo.create).mockRejectedValue(new Error("duplicate key"));
    const { tool } = makeTool(services);

    const res = await tool.handler(VALID);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error rejection instead of reporting an empty message", async () => {
    const services = makeServices();
    vi.mocked(services.dispatchService.dispatchTask).mockRejectedValue("socket hang up");
    const { tool } = makeTool(services);

    const res = await tool.handler(VALID);

    expect(res.content.message).toBe("socket hang up");
  });
});
