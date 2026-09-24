/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler's interesting surface is entirely in the guards and the
 * insert ordering, both of which are cheap to pin and expensive to get
 * wrong:
 *
 *   - `repo_url` is the security-relevant input. Only HTTPS GitHub URLs
 *     may reach the sandbox, so the accept/reject table is enumerated.
 *   - `limits` is clamped, not trusted — an agent asking for a 10-hour
 *     run or a 1 TB disk gets the ceiling instead.
 *   - repo_run.session_id FKs to session.id, so dispatch MUST happen
 *     before the repo_run insert, and the id the tool pre-mints must be
 *     the same one it hands to dispatch. Both are asserted directly.
 *   - Each failure mode returns a distinct `error` code the calling
 *     agent branches on.
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

const AGENT = "agent_a";
const GOOD_URL = "https://github.com/acme/tool";

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

function makeServices(over: Partial<UseRepoServices> = {}): UseRepoServices {
  const agentRepo = {
    findById: vi.fn(async () => fakeAgent()),
  } as unknown as AgentRepository;
  const taskRepo = {
    create: vi.fn(async (input: Partial<Task>) => ({
      status: "open",
      created_at: new Date("2026-05-01"),
      updated_at: new Date("2026-05-01"),
      ...input,
    })),
  } as unknown as TaskRepository;
  const repoRunRepo = { create: vi.fn(async () => undefined) } as unknown as RepoRunRepository;
  const dispatchService = {
    dispatchTask: vi.fn(async () => ({ session: {}, runtime_id: null })),
  } as unknown as DispatchService;
  return { agentRepo, taskRepo, repoRunRepo, dispatchService, ...over };
}

function makeTool(services = makeServices()) {
  return { tool: createUseRepoTool({ agentId: AGENT }, services), services };
}

/** The sole argument a fake repo/service saw on its nth call. */
function argOf<T>(fn: unknown, call = 0): T {
  return (fn as ReturnType<typeof vi.fn>).mock.calls[call]?.[0] as T;
}

interface DispatchArgs {
  agentId: string;
  type: string;
  intent: string;
  reason: { kind: string };
  task: Task;
  sessionIdOverride: string;
}

interface RepoRunInsert {
  id: string;
  session_id: string;
  task_id: string;
  agent_id: string;
  goal: string;
  repo_url: string;
  status: string;
}

describe("use_repo tool definition", () => {
  it("requires goal and repo_url and rejects unknown properties", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing or blank goal before touching any repo", async () => {
    const { tool, services } = makeTool();
    for (const input of [{ repo_url: GOOD_URL }, { goal: "   ", repo_url: GOOD_URL }]) {
      const res = await tool.handler(input);
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("invalid_goal");
    }
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("accepts github.com and its subdomains over HTTPS", async () => {
    for (const url of [
      GOOD_URL,
      "https://github.com/acme/tool.git",
      "https://www.github.com/acme/tool",
      "https://GitHub.com/acme/tool",
    ]) {
      const { tool } = makeTool();
      const res = await tool.handler({ goal: "extract tables", repo_url: url });
      expect(res.isError, url).toBeUndefined();
    }
  });

  it("rejects anything that isn't an HTTPS GitHub URL", async () => {
    for (const url of [
      "",
      "   ",
      "not a url",
      "http://github.com/acme/tool", // plaintext
      "https://gitlab.com/acme/tool", // wrong host
      "https://notgithub.com/acme/tool",
      "https://github.com.evil.test/acme/tool", // suffix-spoofing host
      "git@github.com:acme/tool.git", // ssh remote
    ]) {
      const { tool, services } = makeTool();
      const res = await tool.handler({ goal: "extract tables", repo_url: url });
      expect(res.isError, url).toBe(true);
      expect(res.content.error, url).toBe("invalid_repo_url");
      expect(services.taskRepo.create).not.toHaveBeenCalled();
    }
  });

  it("clamps caller-supplied limits to their ceilings", async () => {
    const { tool } = makeTool();
    const res = await tool.handler({
      goal: "g",
      repo_url: GOOD_URL,
      limits: { wall_clock_minutes: 600, max_install_attempts: 99, disk_mb: 1_000_000 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("passes through in-range limits and floors the integer ones", async () => {
    const { tool } = makeTool();
    const res = await tool.handler({
      goal: "g",
      repo_url: GOOD_URL,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3.7, disk_mb: 512.9 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("drops non-positive, non-numeric and non-object limits", async () => {
    const { tool } = makeTool();
    const bad = await tool.handler({
      goal: "g",
      repo_url: GOOD_URL,
      limits: { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: "big" },
    });
    expect(bad.content.limits).toEqual({});
    const notAnObject = await tool.handler({ goal: "g", repo_url: GOOD_URL, limits: "20m" });
    expect(notAnObject.content.limits).toEqual({});
  });

  it("trims optional input_url / input_filename and omits them when absent", async () => {
    const { tool } = makeTool();
    const withInput = await tool.handler({
      goal: "g",
      repo_url: GOOD_URL,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(withInput.content).toMatchObject({
      input_url: "https://example.test/a.pdf",
      input_filename: "a.pdf",
    });
    const without = await tool.handler({ goal: "g", repo_url: GOOD_URL });
    expect(without.content.input_url).toBeUndefined();
    expect(without.content.input_filename).toBeUndefined();
  });
});

describe("use_repo happy path", () => {
  it("creates a container task titled from the goal", async () => {
    const { tool, services } = makeTool();
    await tool.handler({ goal: "  Extract  the\ntables  ", repo_url: GOOD_URL });
    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Extract the tables",
        description: "Extract  the\ntables",
        assignee_id: AGENT,
        creator_id: AGENT,
        creator_type: "agent",
        priority: "medium",
      }),
    );
  });

  it("elides a container-task title past 80 chars", async () => {
    const { tool, services } = makeTool();
    await tool.handler({ goal: "z".repeat(200), repo_url: GOOD_URL });
    const { title } = argOf<Task>(services.taskRepo.create);
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
  });

  it("dispatches before inserting repo_run, under one shared session id", async () => {
    const order: string[] = [];
    const services = makeServices();
    (services.dispatchService.dispatchTask as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("dispatch");
        return { session: {}, runtime_id: null };
      },
    );
    (services.repoRunRepo.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("repo_run");
    });
    const { tool } = makeTool(services);

    const res = await tool.handler({ goal: "extract tables", repo_url: GOOD_URL });

    // repo_run.session_id FKs to session.id — reversing this orphans the run.
    expect(order).toEqual(["dispatch", "repo_run"]);
    const dispatched = argOf<DispatchArgs>(services.dispatchService.dispatchTask);
    const inserted = argOf<RepoRunInsert>(services.repoRunRepo.create);
    expect(dispatched).toMatchObject({
      agentId: AGENT,
      type: "run_repo",
      intent: "extract tables",
      reason: { kind: "fresh" },
    });
    expect(dispatched.sessionIdOverride).toBe(inserted.session_id);
    expect(inserted).toMatchObject({
      agent_id: AGENT,
      goal: "extract tables",
      repo_url: GOOD_URL,
      status: "pending",
    });
    expect(res.content).toMatchObject({
      repo_run_id: inserted.id,
      session_id: inserted.session_id,
      task_id: inserted.task_id,
      status: "pending",
      watch_url: `/capabilities/runs/${inserted.id}`,
    });
    expect(res.content.note).toContain("Sandbox run started");
  });

  it("ties the repo_run, the dispatch and the response to the same container task", async () => {
    const { tool, services } = makeTool();
    const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
    const dispatched = argOf<DispatchArgs>(services.dispatchService.dispatchTask);
    const inserted = argOf<RepoRunInsert>(services.repoRunRepo.create);
    expect(dispatched.task.id).toBe(res.content.task_id);
    expect(inserted.task_id).toBe(res.content.task_id);
  });
});

describe("use_repo failure modes", () => {
  it("reports a missing caller agent rather than dispatching", async () => {
    const services = makeServices();
    (services.agentRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { tool } = makeTool(services);
    const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("surfaces a dispatch failure and skips the repo_run insert", async () => {
    const services = makeServices();
    (services.dispatchService.dispatchTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("no runtime bound"),
    );
    const { tool } = makeTool(services);
    const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "dispatch_failed", message: "no runtime bound" });
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("surfaces an orphaned session when the repo_run insert fails", async () => {
    const services = makeServices();
    (services.repoRunRepo.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("duplicate key"),
    );
    const { tool } = makeTool(services);
    const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "repo_run_create_failed", message: "duplicate key" });
  });

  it("stringifies a non-Error throw from dispatch", async () => {
    const services = makeServices();
    (services.dispatchService.dispatchTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      "boom",
    );
    const { tool } = makeTool(services);
    const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
    expect(res.content).toEqual({ error: "dispatch_failed", message: "boom" });
  });
});
