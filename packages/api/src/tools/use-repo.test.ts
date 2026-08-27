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
 * The tool is a closure over four ports, so every path below is driven by
 * swapping a fake rather than touching Postgres or the daemon. `order`
 * records the sequence of port calls — the dispatch-before-repo_run
 * ordering is load-bearing (repo_run.session_id FKs to session.id), so it
 * gets asserted rather than assumed.
 */
function harness(
  overrides: {
    agent?: Agent | null;
    dispatch?: () => Promise<unknown>;
    createRepoRun?: () => Promise<unknown>;
  } = {},
) {
  const order: string[] = [];
  const createdTasks: Array<Record<string, unknown>> = [];
  const dispatchArgs: Array<Record<string, unknown>> = [];
  const repoRunArgs: Array<Record<string, unknown>> = [];

  const agent =
    overrides.agent === undefined
      ? ({ id: "agent_caller" } as unknown as Agent)
      : overrides.agent;

  const agentRepo = {
    findById: vi.fn(async (id: string) => {
      order.push("agent.findById");
      expect(id).toBe("agent_caller");
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("task.create");
      createdTasks.push(row);
      return row as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("repoRun.create");
      repoRunArgs.push(row);
      if (overrides.createRepoRun) return overrides.createRepoRun();
      return row;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (args: Record<string, unknown>) => {
      order.push("dispatch");
      dispatchArgs.push(args);
      if (overrides.dispatch) return overrides.dispatch();
      return undefined;
    }),
  } as unknown as DispatchService;

  const services: UseRepoServices = {
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
  };
  const tool = createUseRepoTool({ agentId: "agent_caller" }, services);
  return { tool, order, createdTasks, dispatchArgs, repoRunArgs, services };
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/acme/pdf-tools",
};

describe("use_repo tool", () => {
  describe("descriptor", () => {
    it("exposes the tool name and required fields", () => {
      const { tool } = harness();
      expect(tool.name).toBe("use_repo");
      expect(tool.schema.required).toEqual(["goal", "repo_url"]);
      expect(tool.description).toContain("Docker sandbox");
    });
  });

  describe("happy path", () => {
    it("creates the container task, dispatches, then inserts the repo_run", async () => {
      const { tool, order, createdTasks, dispatchArgs, repoRunArgs } = harness();

      const result = await tool.handler({ ...OK_INPUT });

      expect(result.isError).toBeFalsy();
      // The session row must exist before the repo_run insert; the FK
      // depends on it.
      expect(order).toEqual([
        "agent.findById",
        "task.create",
        "dispatch",
        "repoRun.create",
      ]);

      expect(createdTasks[0]).toMatchObject({
        title: OK_INPUT.goal,
        description: OK_INPUT.goal,
        priority: "medium",
        assignee_id: "agent_caller",
        creator_id: "agent_caller",
        creator_type: "agent",
      });

      expect(dispatchArgs[0]).toMatchObject({
        agentId: "agent_caller",
        type: "run_repo",
        intent: OK_INPUT.goal,
        reason: { kind: "fresh" },
      });

      expect(repoRunArgs[0]).toMatchObject({
        agent_id: "agent_caller",
        goal: OK_INPUT.goal,
        repo_url: OK_INPUT.repo_url,
        status: "pending",
      });
    });

    it("returns the minted ids, and they line up across the three rows", async () => {
      const { tool, createdTasks, dispatchArgs, repoRunArgs } = harness();

      const result = await tool.handler({ ...OK_INPUT });
      const content = result.content as Record<string, string>;

      expect(content.status).toBe("pending");
      expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);

      // The session id handed to dispatch is the one reported back and the
      // one the repo_run row points at.
      expect(dispatchArgs[0]?.sessionIdOverride).toBe(content.session_id);
      expect(repoRunArgs[0]?.session_id).toBe(content.session_id);
      expect(repoRunArgs[0]?.id).toBe(content.repo_run_id);

      // The container task carries the work product.
      expect(content.task_id).toBe(createdTasks[0]?.id);
      expect(repoRunArgs[0]?.task_id).toBe(content.task_id);
      expect(dispatchArgs[0]?.task).toBe(createdTasks[0]);
    });

    it("trims and passes through input_url and input_filename", async () => {
      const { tool } = harness();

      const result = await tool.handler({
        ...OK_INPUT,
        input_url: "  https://example.com/doc.pdf  ",
        input_filename: "  doc.pdf  ",
      });

      expect(result.content).toMatchObject({
        input_url: "https://example.com/doc.pdf",
        input_filename: "doc.pdf",
      });
    });

    it("leaves input_url and input_filename undefined when absent", async () => {
      const { tool } = harness();

      const result = await tool.handler({ ...OK_INPUT });

      expect(result.content.input_url).toBeUndefined();
      expect(result.content.input_filename).toBeUndefined();
    });
  });

  describe("goal validation", () => {
    it.each([
      ["empty string", ""],
      ["whitespace only", "   "],
    ])("rejects a goal that is %s", async (_label, goal) => {
      const { tool, order } = harness();

      const result = await tool.handler({ ...OK_INPUT, goal });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
      // Rejected before any port is touched — no orphan task row.
      expect(order).toEqual([]);
    });

    it("rejects a non-string goal", async () => {
      const { tool, order } = harness();

      const result = await tool.handler({ ...OK_INPUT, goal: 42 });

      expect(result.content).toMatchObject({ error: "invalid_goal" });
      expect(order).toEqual([]);
    });

    it("trims the goal before storing it", async () => {
      const { tool, createdTasks, repoRunArgs } = harness();

      await tool.handler({ ...OK_INPUT, goal: "  do the thing  " });

      expect(createdTasks[0]?.description).toBe("do the thing");
      expect(repoRunArgs[0]?.goal).toBe("do the thing");
    });
  });

  describe("repo_url validation", () => {
    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["plain http", "http://github.com/acme/repo"],
      ["a non-GitHub host", "https://gitlab.com/acme/repo"],
      ["a host that merely ends in the string", "https://notgithub.com/a/b"],
      ["unparseable", "not a url"],
      ["a non-string", 7],
    ])("rejects repo_url that is %s", async (_label, repo_url) => {
      const { tool, order } = harness();

      const result = await tool.handler({ ...OK_INPUT, repo_url });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
      expect(order).toEqual([]);
    });

    it.each([
      ["github.com", "https://github.com/acme/repo"],
      ["a subdomain of github.com", "https://www.github.com/acme/repo"],
    ])("accepts %s", async (_label, repo_url) => {
      const { tool } = harness();

      const result = await tool.handler({ ...OK_INPUT, repo_url });

      expect(result.isError).toBeFalsy();
    });

    it("trims surrounding whitespace before validating", async () => {
      const { tool, repoRunArgs } = harness();

      const result = await tool.handler({
        ...OK_INPUT,
        repo_url: "  https://github.com/acme/repo  ",
      });

      expect(result.isError).toBeFalsy();
      expect(repoRunArgs[0]?.repo_url).toBe("https://github.com/acme/repo");
    });
  });

  describe("container task title", () => {
    it("collapses runs of whitespace", async () => {
      const { tool, createdTasks } = harness();

      await tool.handler({ ...OK_INPUT, goal: "extract\n\ntables   from\tthis" });

      expect(createdTasks[0]?.title).toBe("extract tables from this");
    });

    it("keeps a title of exactly 80 characters intact", async () => {
      const goal = "x".repeat(80);
      const { tool, createdTasks } = harness();

      await tool.handler({ ...OK_INPUT, goal });

      expect(createdTasks[0]?.title).toBe(goal);
    });

    it("truncates a longer title to 77 chars plus an ellipsis", async () => {
      const goal = "y".repeat(81);
      const { tool, createdTasks } = harness();

      await tool.handler({ ...OK_INPUT, goal });

      expect(createdTasks[0]?.title).toBe("y".repeat(77) + "…");
      // The untruncated goal still reaches the description and the run row.
      expect(createdTasks[0]?.description).toBe(goal);
    });
  });

  describe("limits parsing", () => {
    async function limitsFor(limits: unknown) {
      const { tool } = harness();
      const result = await tool.handler({ ...OK_INPUT, limits });
      return (result.content as Record<string, unknown>).limits;
    }

    it("passes sane values through unchanged", async () => {
      expect(
        await limitsFor({
          wall_clock_minutes: 10,
          max_install_attempts: 3,
          disk_mb: 512,
        }),
      ).toEqual({
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 512,
      });
    });

    it("clamps each limit to its ceiling", async () => {
      expect(
        await limitsFor({
          wall_clock_minutes: 999,
          max_install_attempts: 99,
          disk_mb: 1_000_000,
        }),
      ).toEqual({
        wall_clock_minutes: 60,
        max_install_attempts: 5,
        disk_mb: 10_000,
      });
    });

    it("floors the integer limits but leaves wall clock fractional", async () => {
      expect(
        await limitsFor({
          wall_clock_minutes: 1.5,
          max_install_attempts: 2.9,
          disk_mb: 100.7,
        }),
      ).toEqual({
        wall_clock_minutes: 1.5,
        max_install_attempts: 2,
        disk_mb: 100,
      });
    });

    it.each([
      ["zero", 0],
      ["negative", -5],
      ["a string", "10"],
    ])("drops a limit that is %s", async (_label, value) => {
      expect(
        await limitsFor({
          wall_clock_minutes: value,
          max_install_attempts: value,
          disk_mb: value,
        }),
      ).toEqual({});
    });

    it.each([
      ["absent", undefined],
      ["null", null],
      ["not an object", "20"],
    ])("returns an empty object when limits is %s", async (_label, limits) => {
      expect(await limitsFor(limits)).toEqual({});
    });
  });

  describe("failure paths", () => {
    it("reports agent_not_found and creates nothing", async () => {
      const { tool, order } = harness({ agent: null });

      const result = await tool.handler({ ...OK_INPUT });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "agent_not_found" });
      expect(order).toEqual(["agent.findById"]);
    });

    it("reports dispatch_failed without inserting a repo_run", async () => {
      const { tool, order } = harness({
        dispatch: () => Promise.reject(new Error("no daemon online")),
      });

      const result = await tool.handler({ ...OK_INPUT });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "dispatch_failed",
        message: "no daemon online",
      });
      expect(order).not.toContain("repoRun.create");
    });

    it("stringifies a non-Error thrown from dispatch", async () => {
      const { tool } = harness({ dispatch: () => Promise.reject("boom") });

      const result = await tool.handler({ ...OK_INPUT });

      expect(result.content).toMatchObject({
        error: "dispatch_failed",
        message: "boom",
      });
    });

    it("reports repo_run_create_failed when the insert throws", async () => {
      const { tool } = harness({
        createRepoRun: () => Promise.reject(new Error("fk violation")),
      });

      const result = await tool.handler({ ...OK_INPUT });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "repo_run_create_failed",
        message: "fk violation",
      });
    });

    it("stringifies a non-Error thrown from the repo_run insert", async () => {
      const { tool } = harness({ createRepoRun: () => Promise.reject(404) });

      const result = await tool.handler({ ...OK_INPUT });

      expect(result.content).toMatchObject({
        error: "repo_run_create_failed",
        message: "404",
      });
    });
  });
});
