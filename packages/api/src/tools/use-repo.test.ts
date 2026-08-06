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

const AGENT = { id: "agent_a", hierarchy_level: "ic" } as unknown as Agent;

interface Harness {
  services: UseRepoServices;
  createdTasks: Array<Record<string, unknown>>;
  dispatched: Array<Record<string, unknown>>;
  repoRuns: Array<Record<string, unknown>>;
}

function harness(
  overrides: {
    agent?: Agent | null;
    dispatchImpl?: () => Promise<unknown>;
    repoRunCreateImpl?: () => Promise<unknown>;
  } = {},
): Harness {
  const createdTasks: Array<Record<string, unknown>> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const repoRuns: Array<Record<string, unknown>> = [];

  const agentRepo = {
    findById: vi.fn(async () =>
      overrides.agent === undefined ? AGENT : overrides.agent,
    ),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      createdTasks.push(input);
      return { ...input, status: "todo" } as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.repoRunCreateImpl) return overrides.repoRunCreateImpl();
      repoRuns.push(input);
      return input as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.dispatchImpl) return overrides.dispatchImpl();
      dispatched.push(input);
      return { session: { id: input.sessionIdOverride }, runtime_id: null };
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    createdTasks,
    dispatched,
    repoRuns,
  };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: "agent_a" }, h.services);
}

const VALID = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/acme/pdf-tables",
};

describe("use_repo tool", () => {
  describe("descriptor", () => {
    it("exposes the tool name and the two required inputs", () => {
      const t = tool(harness());
      expect(t.name).toBe("use_repo");
      expect(t.schema.required).toEqual(["goal", "repo_url"]);
    });
  });

  describe("input validation", () => {
    it("rejects a missing goal without touching any repository", async () => {
      const h = harness();
      const result = await tool(h).handler({ repo_url: VALID.repo_url });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
      expect(h.services.agentRepo.findById).not.toHaveBeenCalled();
      expect(h.createdTasks).toHaveLength(0);
    });

    it("rejects a whitespace-only goal", async () => {
      const h = harness();
      const result = await tool(h).handler({ ...VALID, goal: "   \n  " });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    });

    it.each([
      ["a non-GitHub host", "https://gitlab.com/acme/tool"],
      ["plain http", "http://github.com/acme/tool"],
      ["a hostname that merely ends in the brand", "https://notgithub.com/a/b"],
      ["an unparseable url", "not-a-url"],
      ["an empty string", ""],
    ])("rejects %s", async (_label, repo_url) => {
      const h = harness();
      const result = await tool(h).handler({ ...VALID, repo_url });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
      expect(h.createdTasks).toHaveLength(0);
    });

    it("accepts a github subdomain over https", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...VALID,
        repo_url: "https://www.github.com/acme/tool",
      });

      expect(result.isError).toBeFalsy();
    });

    it("reports agent_not_found when the caller does not resolve", async () => {
      const h = harness({ agent: null });
      const result = await tool(h).handler(VALID);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "agent_not_found" });
      expect(h.createdTasks).toHaveLength(0);
    });
  });

  describe("happy path", () => {
    it("creates the container task, dispatches, then inserts the repo_run", async () => {
      const h = harness();
      const result = await tool(h).handler(VALID);

      expect(result.isError).toBeFalsy();

      expect(h.createdTasks).toHaveLength(1);
      expect(h.createdTasks[0]).toMatchObject({
        title: VALID.goal,
        description: VALID.goal,
        priority: "medium",
        assignee_id: "agent_a",
        creator_id: "agent_a",
        creator_type: "agent",
      });

      expect(h.dispatched).toHaveLength(1);
      expect(h.dispatched[0]).toMatchObject({
        agentId: "agent_a",
        type: "run_repo",
        intent: VALID.goal,
        reason: { kind: "fresh" },
      });

      expect(h.repoRuns).toHaveLength(1);
      expect(h.repoRuns[0]).toMatchObject({
        agent_id: "agent_a",
        goal: VALID.goal,
        repo_url: VALID.repo_url,
        status: "pending",
      });
    });

    it("returns the ids that the repo_run row was actually written with", async () => {
      const h = harness();
      const result = await tool(h).handler(VALID);
      const content = result.content as Record<string, string>;
      const run = h.repoRuns[0] as Record<string, string>;

      expect(content.repo_run_id).toBe(run.id);
      expect(content.session_id).toBe(run.session_id);
      expect(content.task_id).toBe(run.task_id);
      expect(content.status).toBe("pending");
      expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    });

    it("pre-mints the session id and dispatches under it, so the repo_run FK resolves", async () => {
      const h = harness();
      const result = await tool(h).handler(VALID);

      const dispatchedSid = (h.dispatched[0] as Record<string, string>)
        .sessionIdOverride;
      expect(dispatchedSid).toMatch(/^sess_/);
      expect((h.repoRuns[0] as Record<string, string>).session_id).toBe(
        dispatchedSid,
      );
      expect((result.content as Record<string, string>).session_id).toBe(
        dispatchedSid,
      );
    });

    it("hangs the repo_run off the same container task it dispatched", async () => {
      const h = harness();
      await tool(h).handler(VALID);

      const taskId = (h.createdTasks[0] as Record<string, string>).id;
      expect((h.dispatched[0]?.task as Record<string, string>).id).toBe(taskId);
      expect((h.repoRuns[0] as Record<string, string>).task_id).toBe(taskId);
    });

    it("truncates a long goal for the task title but keeps it whole as the description", async () => {
      const h = harness();
      const goal = "x".repeat(200);
      await tool(h).handler({ ...VALID, goal });

      const created = h.createdTasks[0] as Record<string, string>;
      expect(created.title).toHaveLength(78);
      expect(created.title?.endsWith("…")).toBe(true);
      expect(created.description).toBe(goal);
    });

    it("collapses whitespace in the task title", async () => {
      const h = harness();
      await tool(h).handler({ ...VALID, goal: "  extract\n\n  the   tables  " });

      expect((h.createdTasks[0] as Record<string, string>).title).toBe(
        "extract the tables",
      );
    });

    it("echoes trimmed input_url / input_filename back to the caller", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...VALID,
        input_url: "  https://example.com/a.pdf  ",
        input_filename: "  a.pdf  ",
      });

      expect(result.content).toMatchObject({
        input_url: "https://example.com/a.pdf",
        input_filename: "a.pdf",
      });
    });

    it("omits input_url / input_filename when they are not strings", async () => {
      const h = harness();
      const result = await tool(h).handler({ ...VALID, input_url: 42 });

      expect(result.content.input_url).toBeUndefined();
      expect(result.content.input_filename).toBeUndefined();
    });
  });

  describe("limits parsing", () => {
    it("defaults to an empty object when limits is absent or not an object", async () => {
      for (const limits of [undefined, null, "20", 5]) {
        const h = harness();
        const result = await tool(h).handler({ ...VALID, limits });
        expect(result.content.limits).toEqual({});
      }
    });

    it("passes through in-range values", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...VALID,
        limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 },
      });

      expect(result.content.limits).toEqual({
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 512,
      });
    });

    it("clamps each limit to its ceiling", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...VALID,
        limits: {
          wall_clock_minutes: 999,
          max_install_attempts: 99,
          disk_mb: 1_000_000,
        },
      });

      expect(result.content.limits).toEqual({
        wall_clock_minutes: 60,
        max_install_attempts: 5,
        disk_mb: 10_000,
      });
    });

    it("floors fractional attempt + disk values", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...VALID,
        limits: { max_install_attempts: 2.9, disk_mb: 100.7 },
      });

      expect(result.content.limits).toEqual({
        max_install_attempts: 2,
        disk_mb: 100,
      });
    });

    it("drops non-positive and non-numeric limits rather than clamping them up", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...VALID,
        limits: {
          wall_clock_minutes: 0,
          max_install_attempts: -1,
          disk_mb: "2048",
        },
      });

      expect(result.content.limits).toEqual({});
    });
  });

  describe("failure paths", () => {
    it("surfaces dispatch_failed and never inserts a repo_run", async () => {
      const h = harness({
        dispatchImpl: async () => {
          throw new Error("no runtime bound");
        },
      });
      const result = await tool(h).handler(VALID);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "dispatch_failed",
        message: "no runtime bound",
      });
      expect(h.services.repoRunRepo.create).not.toHaveBeenCalled();
    });

    it("stringifies a non-Error dispatch throw", async () => {
      const h = harness({
        dispatchImpl: async () => {
          throw "boom";
        },
      });
      const result = await tool(h).handler(VALID);

      expect(result.content).toMatchObject({
        error: "dispatch_failed",
        message: "boom",
      });
    });

    it("surfaces repo_run_create_failed when the insert fails after dispatch", async () => {
      const h = harness({
        repoRunCreateImpl: async () => {
          throw new Error("duplicate key");
        },
      });
      const result = await tool(h).handler(VALID);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "repo_run_create_failed",
        message: "duplicate key",
      });
      // The dispatch already happened — the orphan session is the
      // documented, self-recovering cost of this ordering.
      expect(h.dispatched).toHaveLength(1);
    });

    it("stringifies a non-Error repo_run throw", async () => {
      const h = harness({
        repoRunCreateImpl: async () => {
          throw "pg down";
        },
      });
      const result = await tool(h).handler(VALID);

      expect(result.content).toMatchObject({
        error: "repo_run_create_failed",
        message: "pg down",
      });
    });
  });
});
