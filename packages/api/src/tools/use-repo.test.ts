/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler's value is entirely in its guard rails and its ordering
 * contract, neither of which the sandbox e2e covers:
 *
 *   - input validation (empty goal, non-GitHub / non-HTTPS repo_url)
 *   - `limits` clamping, which is the only thing standing between an
 *     agent's typo and a 10-hour container
 *   - the session-before-repo_run insert order (repo_run.session_id has
 *     an FK to session.id), and the two distinct failure envelopes for
 *     the dispatch and the repo_run legs of that sequence
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

const AGENT_ID = "agent_caller";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Caller",
    owner_id: "person_owner",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_container",
    title: "t",
    description: "d",
    status: "pending",
    priority: "medium",
    creator_id: AGENT_ID,
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Task;
}

interface HarnessOpts {
  agent?: Agent | undefined;
  dispatchThrows?: unknown;
  repoRunThrows?: unknown;
}

function harness(opts: HarnessOpts = {}) {
  const agent = "agent" in opts ? opts.agent : fakeAgent();
  /** Call order across the three repos, to assert the FK-driven sequence. */
  const calls: string[] = [];

  const agentRepo = {
    findById: vi.fn(async (id: string) => (id === AGENT_ID ? agent : undefined)),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: { id: string; title: string }) => {
      calls.push("task.create");
      return fakeTask({ id: input.id, title: input.title });
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: { id: string }) => {
      calls.push("repoRun.create");
      if (opts.repoRunThrows !== undefined) throw opts.repoRunThrows;
      return { id: input.id } as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async () => {
      calls.push("dispatch");
      if (opts.dispatchThrows !== undefined) throw opts.dispatchThrows;
      return {} as never;
    }),
  } as unknown as DispatchService;

  const services: UseRepoServices = {
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
  };
  const tool = createUseRepoTool({ agentId: AGENT_ID }, services);
  return { tool, services, calls, agentRepo, taskRepo, repoRunRepo, dispatchService };
}

const GOOD_URL = "https://github.com/jsvine/pdfplumber";

describe("createUseRepoTool", () => {
  it("exposes the MCP surface the agent prompt documents", () => {
    const { tool } = harness();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    // The description is the agent-facing contract for "sandboxed
    // installs are not system installs" — the whole reason the tool
    // gets reached for instead of reporting an install blocker.
    expect(tool.description).toContain("use_repo");
    expect(tool.description).toContain("sandbox");
  });

  describe("input validation", () => {
    it("rejects a missing or blank goal before touching any repo", async () => {
      const { tool, agentRepo } = harness();
      for (const goal of [undefined, "", "   "]) {
        const res = await tool.handler({ goal, repo_url: GOOD_URL });
        expect(res.isError).toBe(true);
        expect(res.content.error).toBe("invalid_goal");
      }
      expect(agentRepo.findById).not.toHaveBeenCalled();
    });

    it("rejects a non-string goal", async () => {
      const { tool } = harness();
      const res = await tool.handler({ goal: 42, repo_url: GOOD_URL });
      expect(res.content.error).toBe("invalid_goal");
    });

    it.each([
      ["missing", undefined],
      ["blank", "   "],
      ["unparseable", "not a url"],
      ["http, not https", "http://github.com/a/b"],
      ["a non-github host", "https://gitlab.com/a/b"],
      // Substring-only match must not pass: the hostname check is
      // anchored so `github.com.evil.test` is refused.
      ["a lookalike host", "https://github.com.evil.test/a/b"],
      ["a non-string", 7],
    ])("rejects a repo_url that is %s", async (_label, repo_url) => {
      const { tool } = harness();
      const res = await tool.handler({ goal: "extract tables", repo_url });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("invalid_repo_url");
    });

    it("accepts a github subdomain and preserves the url verbatim", async () => {
      const { tool, repoRunRepo } = harness();
      const url = "https://www.github.com/jsvine/pdfplumber";
      const res = await tool.handler({ goal: "g", repo_url: ` ${url} ` });
      expect(res.isError).toBeUndefined();
      expect(repoRunRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ repo_url: url }),
      );
    });

    it("errors when the calling agent no longer exists", async () => {
      const { tool, taskRepo } = harness({ agent: undefined });
      const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
      expect(res.isError).toBe(true);
      expect(res.content.error).toBe("agent_not_found");
      expect(taskRepo.create).not.toHaveBeenCalled();
    });
  });

  describe("container task", () => {
    it("pins creator and assignee to the caller and carries the full goal", async () => {
      const { tool, taskRepo } = harness();
      await tool.handler({ goal: "Extract the tables", repo_url: GOOD_URL });
      expect(taskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Extract the tables",
          description: "Extract the tables",
          priority: "medium",
          assignee_id: AGENT_ID,
          creator_id: AGENT_ID,
          creator_type: "agent",
        }),
      );
    });

    it("collapses whitespace and truncates a long goal so the inbox row stays scannable", async () => {
      const { tool, taskRepo } = harness();
      const goal = `${"a".repeat(60)}\n\n   ${"b".repeat(60)}`;
      await tool.handler({ goal, repo_url: GOOD_URL });
      const title = vi.mocked(taskRepo.create).mock.calls[0]![0]!.title!;
      expect(title).toHaveLength(78); // 77 chars + the ellipsis
      expect(title.endsWith("…")).toBe(true);
      expect(title).not.toMatch(/\s\s/);
      // The description keeps the untruncated goal — only the title is cut.
      expect(
        vi.mocked(taskRepo.create).mock.calls[0]![0]!.description,
      ).toBe(goal);
    });

    it("leaves an exactly-80-character goal untruncated", async () => {
      const { tool, taskRepo } = harness();
      const goal = "c".repeat(80);
      await tool.handler({ goal, repo_url: GOOD_URL });
      expect(vi.mocked(taskRepo.create).mock.calls[0]![0]!.title).toBe(goal);
    });
  });

  describe("dispatch ordering", () => {
    it("creates the session via dispatch BEFORE inserting the repo_run (FK order)", async () => {
      const { tool, calls } = harness();
      const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
      expect(calls).toEqual(["task.create", "dispatch", "repoRun.create"]);
      expect(res.isError).toBeUndefined();
    });

    it("dispatches run_repo with the pre-minted session id the repo_run points at", async () => {
      const { tool, dispatchService, repoRunRepo } = harness();
      const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
      const dispatched = vi.mocked(dispatchService.dispatchTask).mock.calls[0]![0]!;
      expect(dispatched).toMatchObject({
        agentId: AGENT_ID,
        type: "run_repo",
        intent: "g",
        reason: { kind: "fresh" },
      });
      const inserted = vi.mocked(repoRunRepo.create).mock.calls[0]![0]!;
      expect(inserted.session_id).toBe(dispatched.sessionIdOverride);
      expect(res.content.session_id).toBe(dispatched.sessionIdOverride);
      expect(inserted.task_id).toBe(res.content.task_id);
      expect(inserted.agent_id).toBe(AGENT_ID);
      expect(inserted.status).toBe("pending");
    });

    it("returns the ids, watch url and polling note on success", async () => {
      const { tool } = harness();
      const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
      expect(res.isError).toBeUndefined();
      expect(res.content.repo_run_id).toMatch(/^repo_/);
      expect(res.content.session_id).toMatch(/^sess_/);
      expect(res.content.status).toBe("pending");
      expect(res.content.watch_url).toBe(
        `/capabilities/runs/${String(res.content.repo_run_id)}`,
      );
      expect(String(res.content.note)).toContain("poll");
    });

    it("mints a fresh repo_run + session id per call", async () => {
      const { tool } = harness();
      const a = await tool.handler({ goal: "g", repo_url: GOOD_URL });
      const b = await tool.handler({ goal: "g", repo_url: GOOD_URL });
      expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
      expect(a.content.session_id).not.toBe(b.content.session_id);
    });

    it("surfaces a dispatch failure as dispatch_failed and skips the repo_run insert", async () => {
      const { tool, calls, repoRunRepo } = harness({
        dispatchThrows: new Error("no runtime online"),
      });
      const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({
        error: "dispatch_failed",
        message: "no runtime online",
      });
      expect(repoRunRepo.create).not.toHaveBeenCalled();
      expect(calls).toEqual(["task.create", "dispatch"]);
    });

    it("surfaces a repo_run insert failure rather than letting the agent wait on an orphan session", async () => {
      const { tool } = harness({ repoRunThrows: new Error("unique violation") });
      const res = await tool.handler({ goal: "g", repo_url: GOOD_URL });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({
        error: "repo_run_create_failed",
        message: "unique violation",
      });
    });

    it("stringifies a non-Error throw on either leg", async () => {
      const dispatched = await harness({ dispatchThrows: "boom" }).tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
      });
      expect(dispatched.content.message).toBe("boom");
      const inserted = await harness({ repoRunThrows: "kaboom" }).tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
      });
      expect(inserted.content.message).toBe("kaboom");
    });
  });

  describe("limits", () => {
    it("echoes no limits when the field is absent or not an object", async () => {
      const { tool } = harness();
      for (const limits of [undefined, null, "20", 20, []]) {
        const res = await tool.handler({ goal: "g", repo_url: GOOD_URL, limits });
        // `[]` is an object, so it parses to {} the same way — the point
        // is that nothing bogus leaks through to the orchestrator.
        expect(res.content.limits).toEqual({});
      }
    });

    it("passes through in-range values", async () => {
      const { tool } = harness();
      const res = await tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
        limits: { wall_clock_minutes: 5, max_install_attempts: 3, disk_mb: 512 },
      });
      expect(res.content.limits).toEqual({
        wall_clock_minutes: 5,
        max_install_attempts: 3,
        disk_mb: 512,
      });
    });

    it("clamps each limit to its ceiling", async () => {
      const { tool } = harness();
      const res = await tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
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
      const { tool } = harness();
      const res = await tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
        limits: {
          wall_clock_minutes: 1.5,
          max_install_attempts: 2.9,
          disk_mb: 100.7,
        },
      });
      expect(res.content.limits).toEqual({
        wall_clock_minutes: 1.5,
        max_install_attempts: 2,
        disk_mb: 100,
      });
    });

    it("drops non-positive and non-numeric limits so the defaults apply", async () => {
      const { tool } = harness();
      const res = await tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
        limits: {
          wall_clock_minutes: 0,
          max_install_attempts: -1,
          disk_mb: "2048",
        },
      });
      expect(res.content.limits).toEqual({});
    });
  });

  describe("sandbox input plumbing", () => {
    it("trims and echoes input_url + input_filename", async () => {
      const { tool } = harness();
      const res = await tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
        input_url: "  https://example.test/a.pdf  ",
        input_filename: " a.pdf ",
      });
      expect(res.content.input_url).toBe("https://example.test/a.pdf");
      expect(res.content.input_filename).toBe("a.pdf");
    });

    it("leaves both undefined when omitted or non-string", async () => {
      const { tool } = harness();
      const res = await tool.handler({
        goal: "g",
        repo_url: GOOD_URL,
        input_filename: 12,
      });
      expect(res.content.input_url).toBeUndefined();
      expect(res.content.input_filename).toBeUndefined();
    });
  });
});
