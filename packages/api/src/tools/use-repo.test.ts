/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB).
 *
 * The handler is the Capability Network's write path: it validates the
 * agent-supplied goal + repo URL, mints a container task, dispatches a
 * `run_repo` session under a pre-minted session id, then inserts the
 * repo_run row that the daemon joins on. Three things are worth pinning:
 *
 *   - the URL guard (only https GitHub hosts get through),
 *   - the dispatch-before-repo_run ordering and the shared session id
 *     (repo_run.session_id has an FK to the session dispatch created),
 *   - the two failure envelopes, since a swallowed error here leaves the
 *     agent polling a run that will never start.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRun,
  RepoRunRepository,
  Session,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool } from "./use-repo.js";

const AGENT = "agent_a";
const REPO = "https://github.com/acme/pdf-tools";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "A",
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
    id: "task_1",
    title: "Extract tables",
    status: "pending",
    priority: "medium",
    creator_id: AGENT,
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function buildServices(
  overrides: {
    agentRepo?: Partial<AgentRepository>;
    taskRepo?: Partial<TaskRepository>;
    repoRunRepo?: Partial<RepoRunRepository>;
    dispatchService?: Partial<DispatchService>;
  } = {},
) {
  const agentRepo = {
    findById: vi.fn(async () => fakeAgent()),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Parameters<TaskRepository["create"]>[0]) =>
      fakeTask(input as Partial<Task>),
    ),
    ...overrides.taskRepo,
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(
      async (input: Parameters<RepoRunRepository["create"]>[0]) =>
        input as unknown as RepoRun,
    ),
    ...overrides.repoRunRepo,
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: { agentId: string }) => ({
      session: {
        id: "sess_dispatched",
        agent_id: input.agentId,
        type: "run_repo",
        status: "pending",
        intent: "x",
        created_at: new Date("2026-04-01"),
      } as Session,
      runtime_id: null,
    })),
    ...overrides.dispatchService,
  } as unknown as DispatchService;

  return { agentRepo, taskRepo, repoRunRepo, dispatchService };
}

function build(
  overrides: Parameters<typeof buildServices>[0] = {},
  ctx: { agentId: string } = { agentId: AGENT },
) {
  const services = buildServices(overrides);
  return { tool: createUseRepoTool(ctx, services), services };
}

describe("use_repo tool descriptor", () => {
  it("advertises goal + repo_url as the required inputs", () => {
    const { tool } = build();

    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.description).toContain("Docker sandbox");
  });
});

describe("use_repo input validation", () => {
  it("rejects a blank goal without touching any repo", async () => {
    const { tool, services } = build();

    const result = await tool.handler({ goal: "   ", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a missing goal (non-string input)", async () => {
    const { tool } = build();

    const result = await tool.handler({ repo_url: REPO });

    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it.each([
    ["a non-GitHub host", "https://gitlab.com/acme/tool"],
    ["plain http", "http://github.com/acme/tool"],
    ["a lookalike host", "https://notgithub.com/acme/tool"],
    ["an unparseable url", "github.com/acme/tool"],
    ["an empty string", "   "],
  ])("rejects %s as repo_url", async (_label, repoUrl) => {
    const { tool, services } = build();

    const result = await tool.handler({ goal: "extract tables", repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("accepts a github subdomain over https", async () => {
    const { tool } = build();

    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://www.github.com/acme/tool",
    });

    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const { tool, services } = build({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });

    const result = await tool.handler({ goal: "extract tables", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const { tool, services } = build();

    const result = await tool.handler({ goal: "extract tables", repo_url: REPO });

    expect(result.isError).toBeFalsy();
    const content = result.content as Record<string, string>;

    // Container task carries the goal verbatim and is both created by and
    // assigned to the calling agent.
    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "extract tables",
        description: "extract tables",
        assignee_id: AGENT,
        creator_id: AGENT,
        creator_type: "agent",
      }),
    );

    // Dispatch runs before the repo_run insert and pins the session id.
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        type: "run_repo",
        intent: "extract tables",
        reason: { kind: "fresh" },
        sessionIdOverride: content.session_id,
      }),
    );

    // repo_run joins the dispatched session and the container task.
    expect(services.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: content.repo_run_id,
        session_id: content.session_id,
        task_id: content.task_id,
        agent_id: AGENT,
        goal: "extract tables",
        repo_url: REPO,
        status: "pending",
      }),
    );
  });

  it("returns the ids, pending status and the watch url the UI polls", async () => {
    const { tool } = build();

    const result = await tool.handler({ goal: "extract tables", repo_url: REPO });
    const content = result.content as Record<string, unknown>;

    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${String(content.repo_run_id)}`);
    expect(typeof content.session_id).toBe("string");
    expect(typeof content.task_id).toBe("string");
    expect(content.note).toContain("Sandbox run started");
  });

  it("passes input_url + input_filename back trimmed, and omits them when absent", async () => {
    const { tool } = build();

    const withInput = await tool.handler({
      goal: "extract tables",
      repo_url: REPO,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(withInput.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });

    const withoutInput = await tool.handler({ goal: "extract tables", repo_url: REPO });
    expect(withoutInput.content.input_url).toBeUndefined();
    expect(withoutInput.content.input_filename).toBeUndefined();
  });

  it("collapses whitespace and truncates the container task title at 80 chars", async () => {
    const { tool, services } = build();
    const goal = `${"extract  tables\nfrom  the  pdf ".repeat(6)}end`;

    await tool.handler({ goal, repo_url: REPO });

    const created = vi.mocked(services.taskRepo.create).mock.calls[0]?.[0];
    expect(created?.title).toHaveLength(78); // 77 chars + the ellipsis
    expect(created?.title.endsWith("…")).toBe(true);
    // The full goal still reaches the description and the dispatch intent.
    expect(created?.description).toBe(goal);
  });

  it("keeps a short title untouched", async () => {
    const { tool, services } = build();

    await tool.handler({ goal: "  extract   tables  ", repo_url: REPO });

    const created = vi.mocked(services.taskRepo.create).mock.calls[0]?.[0];
    expect(created?.title).toBe("extract tables");
  });
});

describe("use_repo limit parsing", () => {
  it("clamps each limit to its ceiling and floors the integer ones", async () => {
    const { tool } = build();

    const result = await tool.handler({
      goal: "extract tables",
      repo_url: REPO,
      limits: { wall_clock_minutes: 999, max_install_attempts: 9.7, disk_mb: 99_999 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("passes in-range limits through, flooring the integer ones", async () => {
    const { tool } = build();

    const result = await tool.handler({
      goal: "extract tables",
      repo_url: REPO,
      limits: { wall_clock_minutes: 5, max_install_attempts: 3.9, disk_mb: 512.5 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 5,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it.each([
    ["a non-object", "20"],
    ["null", null],
    ["nothing", undefined],
  ])("returns empty limits for %s", async (_label, limits) => {
    const { tool } = build();

    const result = await tool.handler({ goal: "g", repo_url: REPO, limits });

    expect(result.content.limits).toEqual({});
  });

  it("drops non-positive and non-numeric limit values", async () => {
    const { tool } = build();

    const result = await tool.handler({
      goal: "g",
      repo_url: REPO,
      limits: { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: "2048" },
    });

    expect(result.content.limits).toEqual({});
  });
});

describe("use_repo failure envelopes", () => {
  it("surfaces a dispatch failure and never inserts the repo_run", async () => {
    const { tool, services } = build({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no daemon online");
        }),
      },
    });

    const result = await tool.handler({ goal: "g", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { tool } = build({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw "boom";
        }),
      },
    });

    const result = await tool.handler({ goal: "g", repo_url: REPO });

    expect(result.content).toMatchObject({ error: "dispatch_failed", message: "boom" });
  });

  it("surfaces a repo_run insert failure rather than leaving the agent waiting", async () => {
    const { tool } = build({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw new Error("fk violation");
        }),
      },
    });

    const result = await tool.handler({ goal: "g", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { tool } = build({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw "kaput";
        }),
      },
    });

    const result = await tool.handler({ goal: "g", repo_url: REPO });

    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "kaput",
    });
  });
});
