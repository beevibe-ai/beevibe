/**
 * use_repo handler tests — validation, the dispatch-then-repo_run
 * ordering the handler's comments call out, and both failure paths
 * around that ordering.
 *
 * All four collaborators are injected ports, so the whole handler runs
 * against fakes: no Docker, no daemon, no Postgres.
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

const AGENT = { id: "agent_caller" } as unknown as Agent;

function fakeServices(
  overrides: {
    agent?: Agent | null;
    dispatchError?: Error;
    repoRunError?: Error;
  } = {},
) {
  const created: Array<Record<string, unknown>> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const repoRuns: Array<Record<string, unknown>> = [];

  const agentRepo = {
    findById: vi.fn(async () =>
      overrides.agent === undefined ? AGENT : overrides.agent,
    ),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      created.push(row);
      return row as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      if (overrides.repoRunError) throw overrides.repoRunError;
      repoRuns.push(row);
      return row;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.dispatchError) throw overrides.dispatchError;
      dispatched.push(input);
      return {};
    }),
  } as unknown as DispatchService;

  const services: UseRepoServices = {
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
  };
  return { services, created, dispatched, repoRuns };
}

function tool(services: UseRepoServices) {
  return createUseRepoTool({ agentId: "agent_caller" }, services);
}

describe("use_repo input validation", () => {
  it("rejects a blank goal before touching any port", async () => {
    const { services } = fakeServices();
    const result = await tool(services).handler({
      goal: "   ",
      repo_url: "https://github.com/acme/widget",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects a missing goal", async () => {
    const { services } = fakeServices();
    const result = await tool(services).handler({
      repo_url: "https://github.com/acme/widget",
    });
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  // The guard is a hostname + protocol check, not a path check — these
  // are the cases an agent plausibly passes after a web search.
  it.each([
    ["no url at all", undefined],
    ["a non-url string", "not a url"],
    ["http instead of https", "http://github.com/acme/widget"],
    ["a lookalike host", "https://github.com.evil.test/acme/widget"],
    ["a different forge", "https://gitlab.com/acme/widget"],
    ["an ssh remote", "git@github.com:acme/widget.git"],
  ])("rejects %s", async (_label, repoUrl) => {
    const { services } = fakeServices();
    const result = await tool(services).handler({
      goal: "extract the tables",
      ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
  });

  it.each([
    "https://github.com/acme/widget",
    "https://www.github.com/acme/widget",
    "https://GitHub.com/acme/widget",
  ])("accepts %s", async (repoUrl) => {
    const { services } = fakeServices();
    const result = await tool(services).handler({
      goal: "extract the tables",
      repo_url: repoUrl,
    });
    expect(result.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller token resolves to nothing", async () => {
    const { services, created } = fakeServices({ agent: null });
    const result = await tool(services).handler({
      goal: "extract the tables",
      repo_url: "https://github.com/acme/widget",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // No container task for a caller that doesn't exist.
    expect(created).toHaveLength(0);
  });
});

describe("use_repo limits parsing", () => {
  async function limitsFor(raw: unknown) {
    const { services } = fakeServices();
    const result = await tool(services).handler({
      goal: "extract the tables",
      repo_url: "https://github.com/acme/widget",
      limits: raw,
    });
    return (result.content as { limits: Record<string, number> }).limits;
  }

  it("passes through in-range values", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 4096,
      }),
    ).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt + disk caps but not the wall clock", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 1.5,
        max_install_attempts: 2.9,
        disk_mb: 512.7,
      }),
    ).toEqual({
      wall_clock_minutes: 1.5,
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric values rather than defaulting them", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      }),
    ).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a non-object", 42],
  ])("treats %s limits as empty", async (_label, raw) => {
    expect(await limitsFor(raw)).toEqual({});
  });
});

describe("use_repo happy path", () => {
  const GOAL = "Extract the tables from this PDF as JSON";

  it("creates the container task with the caller as both assignee and creator", async () => {
    const { services, created } = fakeServices();
    await tool(services).handler({
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: GOAL,
      description: GOAL,
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });
  });

  it("collapses whitespace and ellipsizes a long goal into the task title", async () => {
    const { services, created } = fakeServices();
    const longGoal = "a".repeat(100);
    await tool(services).handler({
      goal: `  extract\n\tthe   tables  `,
      repo_url: "https://github.com/acme/widget",
    });
    expect(created[0]?.title).toBe("extract the tables");

    const second = fakeServices();
    await tool(second.services).handler({
      goal: longGoal,
      repo_url: "https://github.com/acme/widget",
    });
    const title = second.created[0]?.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const { services, dispatched, created } = fakeServices();
    const result = await tool(services).handler({
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
    });

    const content = result.content as Record<string, string>;
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: GOAL,
      reason: { kind: "fresh" },
      sessionIdOverride: content.session_id,
    });
    expect(dispatched[0]?.task).toBe(created[0]);
  });

  it("inserts the repo_run after the dispatch, tied to the same session + task", async () => {
    const { services, repoRuns } = fakeServices();
    const result = await tool(services).handler({
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
    });
    const content = result.content as Record<string, string>;

    expect(repoRuns).toHaveLength(1);
    expect(repoRuns[0]).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_caller",
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
      status: "pending",
    });
  });

  it("orders the dispatch before the repo_run insert (repo_run.session_id FK)", async () => {
    const order: string[] = [];
    const { services } = fakeServices();
    vi.mocked(services.dispatchService.dispatchTask).mockImplementation(
      async () => {
        order.push("dispatch");
        return {} as never;
      },
    );
    vi.mocked(services.repoRunRepo.create).mockImplementation((async (
      row: unknown,
    ) => {
      order.push("repo_run");
      return row;
    }) as never);

    await tool(services).handler({
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
    });
    expect(order).toEqual(["dispatch", "repo_run"]);
  });

  it("returns the ids, the watch url and the don't-poll-me note", async () => {
    const { services } = fakeServices();
    const result = await tool(services).handler({
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
      input_url: "  https://example.test/in.pdf  ",
      input_filename: "  in.pdf  ",
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Record<string, unknown>;
    expect(content.status).toBe("pending");
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^ses/);
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    expect(content.note).toContain("poll");
    // Both input hints are trimmed and echoed for the daemon payload.
    expect(content.input_url).toBe("https://example.test/in.pdf");
    expect(content.input_filename).toBe("in.pdf");
  });

  it("leaves the input hints undefined when not supplied", async () => {
    const { services } = fakeServices();
    const result = await tool(services).handler({
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
      input_url: 42,
    });
    const content = result.content as Record<string, unknown>;
    expect(content.input_url).toBeUndefined();
    expect(content.input_filename).toBeUndefined();
  });

  it("mints a fresh repo_run + session id per call", async () => {
    const { services } = fakeServices();
    const t = tool(services);
    const a = (await t.handler({
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
    })).content as Record<string, string>;
    const b = (await t.handler({
      goal: GOAL,
      repo_url: "https://github.com/acme/widget",
    })).content as Record<string, string>;

    expect(a.repo_run_id).not.toBe(b.repo_run_id);
    expect(a.session_id).not.toBe(b.session_id);
  });
});

describe("use_repo failure paths", () => {
  const INPUT = {
    goal: "extract the tables",
    repo_url: "https://github.com/acme/widget",
  };

  it("surfaces dispatch_failed and never inserts a repo_run", async () => {
    const { services, repoRuns } = fakeServices({
      dispatchError: new Error("no daemon online"),
    });
    const result = await tool(services).handler(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(repoRuns).toHaveLength(0);
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { services } = fakeServices();
    vi.mocked(services.dispatchService.dispatchTask).mockRejectedValue(
      "boom" as never,
    );
    const result = await tool(services).handler(INPUT);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  // The orphan-session case the handler documents: the session landed,
  // the repo_run didn't. It self-recovers, but must not look like success.
  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const { services, dispatched } = fakeServices({
      repoRunError: new Error("unique violation"),
    });
    const result = await tool(services).handler(INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "unique violation",
    });
    expect(dispatched).toHaveLength(1);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { services } = fakeServices();
    vi.mocked(services.repoRunRepo.create).mockRejectedValue("nope" as never);
    const result = await tool(services).handler(INPUT);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "nope",
    });
  });
});

describe("use_repo tool surface", () => {
  it("declares goal + repo_url required and nothing else", () => {
    const { services } = fakeServices();
    const t = tool(services);
    expect(t.name).toBe("use_repo");
    const schema = t.schema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["goal", "repo_url"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "goal",
      "input_filename",
      "input_url",
      "limits",
      "repo_url",
    ]);
  });
});
