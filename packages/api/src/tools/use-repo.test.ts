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
 * use_repo hands an arbitrary GitHub repo to a child agent inside a
 * fresh Docker sandbox. The handler itself does no sandbox work — it
 * validates, creates a container task, dispatches, and inserts the
 * repo_run row.
 *
 * Two things make it worth pinning down:
 *
 *   • It is an untrusted-input boundary. `repo_url` comes from an LLM
 *     that may have hallucinated it, and `limits` is agent-supplied.
 *     Both get clamped here or not at all.
 *
 *   • The write order is load-bearing. `repo_run.session_id` has an FK
 *     to `session.id`, so dispatch (which creates the session row) must
 *     land before the repo_run insert, and the pre-minted session id
 *     must be the *same* one on both sides. A regression there is an
 *     FK violation in production and invisible in a unit test that only
 *     checks the return value.
 */

const AGENT_ID = "agent_caller";
const REPO_URL = "https://github.com/acme/pdf-tools";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    owner_id: "person_owner",
    hierarchy_level: "ic",
    ...overrides,
  } as Agent;
}

/** Pass `{ agent: undefined }` for the caller-not-found case — an
 *  omitted argument still yields a valid agent. */
function fakeAgentRepo(
  opts: { agent?: Agent } = { agent: fakeAgent() },
): AgentRepository {
  return {
    findById: vi.fn(async () => opts.agent),
  } as unknown as AgentRepository;
}

function fakeTaskRepo(): TaskRepository {
  return {
    create: vi.fn(async (input: { id: string }) => ({ ...input }) as Task),
  } as unknown as TaskRepository;
}

function fakeRepoRunRepo(opts: { throws?: Error } = {}): RepoRunRepository {
  return {
    create: vi.fn(async (input: Record<string, unknown>) => {
      if (opts.throws) throw opts.throws;
      return input;
    }),
  } as unknown as RepoRunRepository;
}

function fakeDispatchService(opts: { throws?: unknown } = {}): DispatchService {
  return {
    dispatchTask: vi.fn(async () => {
      if (opts.throws) throw opts.throws;
      return { sessionId: "ignored" };
    }),
  } as unknown as DispatchService;
}

function services(overrides: Partial<UseRepoServices> = {}): UseRepoServices {
  return {
    agentRepo: fakeAgentRepo(),
    taskRepo: fakeTaskRepo(),
    repoRunRepo: fakeRepoRunRepo(),
    dispatchService: fakeDispatchService(),
    ...overrides,
  };
}

function tool(svc: UseRepoServices = services()) {
  return {
    handler: createUseRepoTool({ agentId: AGENT_ID }, svc).handler,
    svc,
  };
}

function call(
  input: Record<string, unknown> = {},
  svc: UseRepoServices = services(),
) {
  const t = tool(svc);
  return t.handler({ goal: "extract tables", repo_url: REPO_URL, ...input });
}

function mockOf(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

/** The single row handed to taskRepo.create. */
function createdTask(svc: UseRepoServices): { title: string; description: string } {
  const call = mockOf(svc.taskRepo.create).mock.calls[0];
  if (!call) throw new Error("taskRepo.create was never called");
  return call[0] as { title: string; description: string };
}

/** Order in which two mocks were first invoked, relative to each other. */
function firstCallOrder(fn: unknown): number {
  const order = mockOf(fn).mock.invocationCallOrder[0];
  if (order === undefined) throw new Error("mock was never called");
  return order;
}

describe("createUseRepoTool", () => {
  it("exposes goal + repo_url as the required schema fields", () => {
    const t = createUseRepoTool({ agentId: AGENT_ID }, services());

    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    expect(t.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const svc = services();
    const res = await call({ goal: "Extract the tables as JSON" }, svc);

    expect(res.isError).toBeUndefined();
    expect(svc.taskRepo.create).toHaveBeenCalledTimes(1);
    expect(svc.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    expect(svc.repoRunRepo.create).toHaveBeenCalledTimes(1);

    // The FK ordering the module comment calls out: the session row has
    // to exist before repo_run references it.
    expect(firstCallOrder(svc.dispatchService.dispatchTask)).toBeLessThan(
      firstCallOrder(svc.repoRunRepo.create),
    );
  });

  it("returns freshly minted, correctly prefixed ids and a watch url", async () => {
    const res = await call();

    expect(res.content.repo_run_id).toMatch(/^repo_/);
    expect(res.content.session_id).toMatch(/^sess_/);
    expect(res.content.task_id).toMatch(/^task_/);
    expect(res.content.status).toBe("pending");
    expect(res.content.watch_url).toBe(
      `/capabilities/runs/${res.content.repo_run_id}`,
    );
    expect(res.content.note).toContain("poll");
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const svc = services();
    const res = await call({ goal: "Rip the audio" }, svc);

    expect(svc.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        type: "run_repo",
        intent: "Rip the audio",
        reason: { kind: "fresh" },
        sessionIdOverride: res.content.session_id,
      }),
    );
  });

  it("writes the repo_run against that same session and task", async () => {
    const svc = services();
    const res = await call({ goal: "Rip the audio" }, svc);

    expect(svc.repoRunRepo.create).toHaveBeenCalledWith({
      id: res.content.repo_run_id,
      session_id: res.content.session_id,
      task_id: res.content.task_id,
      agent_id: AGENT_ID,
      goal: "Rip the audio",
      repo_url: REPO_URL,
      status: "pending",
    });
  });

  it("pins the container task to the resolved agent as both creator and assignee", async () => {
    const svc = services();
    await call({ goal: "Extract tables" }, svc);

    expect(svc.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee_id: AGENT_ID,
        creator_id: AGENT_ID,
        creator_type: "agent",
        priority: "medium",
        description: "Extract tables",
      }),
    );
  });

  it("uses the resolved agent's id, not the raw context id", async () => {
    // findById is the authority; if the repo returns a different row the
    // task and repo_run should follow it.
    const svc = services({
      agentRepo: fakeAgentRepo({ agent: fakeAgent({ id: "agent_resolved" }) }),
    });
    await call({}, svc);

    expect(svc.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ assignee_id: "agent_resolved" }),
    );
    expect(svc.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: "agent_resolved" }),
    );
  });

  it("trims surrounding whitespace off goal and repo_url", async () => {
    const svc = services();
    await call({ goal: "  extract tables  ", repo_url: `  ${REPO_URL}  ` }, svc);

    expect(svc.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "extract tables", repo_url: REPO_URL }),
    );
  });
});

describe("use_repo container task title", () => {
  it("collapses runs of whitespace so the inbox row stays scannable", async () => {
    const svc = services();
    await call({ goal: "extract\n\n  the   tables" }, svc);

    expect(svc.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "extract the tables" }),
    );
  });

  it("keeps a title of exactly 80 chars intact", async () => {
    const goal = "x".repeat(80);
    const svc = services();
    await call({ goal }, svc);

    const { title } = createdTask(svc);
    expect(title).toBe(goal);
    expect(title).toHaveLength(80);
  });

  it("truncates a longer title to 77 chars plus an ellipsis", async () => {
    const goal = "y".repeat(200);
    const svc = services();
    await call({ goal }, svc);

    const { title } = createdTask(svc);
    expect(title).toBe("y".repeat(77) + "…");
    expect(title).toHaveLength(78);
  });

  it("truncates the title but stores the full goal as the description", async () => {
    const goal = "z".repeat(120);
    const svc = services();
    await call({ goal }, svc);

    const created = createdTask(svc);
    expect(created.description).toBe(goal);
    expect(created.title).not.toBe(goal);
  });
});

describe("use_repo input validation", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["non-string", 42],
  ])("rejects a %s goal", async (_label, goal) => {
    const svc = services();
    const res = await call({ goal }, svc);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(svc.taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-GitHub host", "https://gitlab.com/acme/repo"],
    ["plain http", "http://github.com/acme/repo"],
    ["an unparseable url", "not a url"],
    ["an empty string", ""],
    ["a lookalike host", "https://github.com.evil.test/acme/repo"],
    ["a suffix-only lookalike", "https://notgithub.com/acme/repo"],
    ["an ssh remote", "git@github.com:acme/repo.git"],
  ])("rejects %s", async (_label, repo_url) => {
    const svc = services();
    const res = await call({ repo_url }, svc);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(svc.taskRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a non-string repo_url", async () => {
    const res = await call({ repo_url: { url: REPO_URL } });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
  });

  it.each([
    ["a subdomain of github.com", "https://gist.github.com/acme/abc123"],
    ["an uppercase host", "https://GitHub.com/acme/repo"],
    ["a url with a query string", "https://github.com/acme/repo?tab=readme"],
  ])("accepts %s", async (_label, repo_url) => {
    const res = await call({ repo_url });

    expect(res.isError).toBeUndefined();
  });

  it("checks the goal before the repo_url", async () => {
    const res = await call({ goal: "", repo_url: "https://gitlab.com/x/y" });

    expect(res.content.error).toBe("invalid_goal");
  });

  it("validates input before looking the agent up", async () => {
    const svc = services();
    await call({ goal: "" }, svc);

    expect(svc.agentRepo.findById).not.toHaveBeenCalled();
  });
});

describe("use_repo limits clamping", () => {
  it("passes through in-range limits unchanged", async () => {
    const res = await call({
      limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 1024 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its documented ceiling", async () => {
    const res = await call({
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 500_000,
      },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    const res = await call({
      limits: { max_install_attempts: 2.9, disk_mb: 512.7 },
    });

    expect(res.content.limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a string", "20"],
    ["null", null],
  ])("drops %s limit values rather than clamping them", async (_label, value) => {
    const res = await call({
      limits: {
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      },
    });

    expect(res.content.limits).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a string", "generous"],
    ["a number", 5],
  ])("treats %s limits as no limits", async (_label, limits) => {
    const res = await call({ limits });

    expect(res.content.limits).toEqual({});
  });

  it("keeps the valid half of a partly-bogus limits object", async () => {
    const res = await call({
      limits: { wall_clock_minutes: 10, disk_mb: -1 },
    });

    expect(res.content.limits).toEqual({ wall_clock_minutes: 10 });
  });
});

describe("use_repo optional input file", () => {
  it("echoes a trimmed input_url and input_filename", async () => {
    const res = await call({
      input_url: "  https://example.test/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(res.content.input_url).toBe("https://example.test/report.pdf");
    expect(res.content.input_filename).toBe("report.pdf");
  });

  it("leaves both undefined when not supplied", async () => {
    const res = await call();

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });

  it("ignores non-string values", async () => {
    const res = await call({ input_url: 12, input_filename: false });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo failure paths", () => {
  it("reports agent_not_found and writes nothing when the caller is unknown", async () => {
    const svc = services({ agentRepo: fakeAgentRepo({ agent: undefined }) });
    const res = await call({}, svc);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(svc.taskRepo.create).not.toHaveBeenCalled();
    expect(svc.dispatchService.dispatchTask).not.toHaveBeenCalled();
    expect(svc.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("reports dispatch_failed and skips the repo_run insert", async () => {
    // No session row landed, so inserting repo_run would violate the FK.
    const svc = services({
      dispatchService: fakeDispatchService({ throws: new Error("no daemon online") }),
    });
    const res = await call({}, svc);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(svc.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const svc = services({
      dispatchService: fakeDispatchService({ throws: "runtime unavailable" }),
    });
    const res = await call({}, svc);

    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "runtime unavailable",
    });
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const svc = services({
      repoRunRepo: fakeRepoRunRepo({ throws: new Error("duplicate key") }),
    });
    const res = await call({}, svc);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("lets a container-task failure propagate rather than swallowing it", async () => {
    // There is no try/catch around taskRepo.create — an unexpected
    // failure there should surface as a thrown error, not a success
    // envelope with a missing task_id.
    const svc = services({
      taskRepo: {
        create: vi.fn(async () => {
          throw new Error("task insert failed");
        }),
      } as unknown as TaskRepository,
    });

    await expect(call({}, svc)).rejects.toThrow("task insert failed");
  });
});
