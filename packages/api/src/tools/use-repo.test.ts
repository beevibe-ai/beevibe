import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

interface Harness {
  services: UseRepoServices;
  createdTasks: Array<Record<string, unknown>>;
  dispatches: Array<Record<string, unknown>>;
  repoRuns: Array<Record<string, unknown>>;
  /** Call order across the three collaborators, for ordering assertions. */
  order: string[];
}

function harness(
  opts: {
    agent?: { id: string } | null;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const createdTasks: Array<Record<string, unknown>> = [];
  const dispatches: Array<Record<string, unknown>> = [];
  const repoRuns: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const agent = opts.agent === undefined ? { id: "agent_a" } : opts.agent;

  const agentRepo = {
    findById: vi.fn(async () => agent),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (t: Record<string, unknown>) => {
      order.push("task.create");
      createdTasks.push(t);
      return t as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (r: Record<string, unknown>) => {
      order.push("repoRun.create");
      if (opts.repoRunThrows) throw opts.repoRunThrows;
      repoRuns.push(r);
      return r;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (d: Record<string, unknown>) => {
      order.push("dispatch");
      if (opts.dispatchThrows) throw opts.dispatchThrows;
      dispatches.push(d);
      return {};
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    createdTasks,
    dispatches,
    repoRuns,
    order,
  };
}

function tool(h: Harness, agentId = "agent_a") {
  return createUseRepoTool({ agentId }, h.services);
}

const GOOD = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool", () => {
  describe("descriptor", () => {
    it("exposes the tool name and required inputs", () => {
      const t = tool(harness());
      expect(t.name).toBe("use_repo");
      expect(t.schema.required).toEqual(["goal", "repo_url"]);
    });
  });

  describe("input validation", () => {
    it("rejects an empty goal without touching any repository", async () => {
      const h = harness();
      const result = await tool(h).handler({ goal: "   ", repo_url: GOOD.repo_url });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
      expect(h.order).toEqual([]);
    });

    it("rejects a missing goal", async () => {
      const h = harness();
      const result = await tool(h).handler({ repo_url: GOOD.repo_url });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    });

    it("rejects a non-string goal", async () => {
      const h = harness();
      const result = await tool(h).handler({ goal: 42, repo_url: GOOD.repo_url });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    });

    it.each([
      ["a missing url", undefined],
      ["an empty url", "   "],
      ["a non-GitHub host", "https://gitlab.com/foo/bar"],
      ["plain http", "http://github.com/foo/bar"],
      ["an unparseable url", "not-a-url"],
      ["a lookalike host", "https://notgithub.com/foo/bar"],
      ["a host with github.com as a prefix", "https://github.com.evil.io/foo/bar"],
      ["a non-string url", 7],
    ])("rejects %s", async (_label, repo_url) => {
      const h = harness();
      const result = await tool(h).handler({ goal: GOOD.goal, repo_url });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
      expect(h.order).toEqual([]);
    });

    it.each([
      ["a canonical https github url", "https://github.com/jsvine/pdfplumber"],
      ["a subdomain of github.com", "https://www.github.com/jsvine/pdfplumber"],
      ["a mixed-case host", "https://GitHub.com/jsvine/pdfplumber"],
      ["a url with a .git suffix", "https://github.com/jsvine/pdfplumber.git"],
    ])("accepts %s", async (_label, repo_url) => {
      const h = harness();
      const result = await tool(h).handler({ goal: GOOD.goal, repo_url });

      expect(result.isError).toBeFalsy();
    });

    it("trims surrounding whitespace off the goal and repo_url", async () => {
      const h = harness();
      const result = await tool(h).handler({
        goal: "  do the thing  ",
        repo_url: `  ${GOOD.repo_url}  `,
      });

      expect(result.isError).toBeFalsy();
      expect(h.createdTasks[0]).toMatchObject({ description: "do the thing" });
      expect(h.repoRuns[0]).toMatchObject({
        goal: "do the thing",
        repo_url: GOOD.repo_url,
      });
    });
  });

  describe("caller resolution", () => {
    it("returns agent_not_found when the calling agent is missing", async () => {
      const h = harness({ agent: null });
      const result = await tool(h).handler(GOOD);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "agent_not_found" });
      expect(h.order).toEqual([]);
    });

    it("looks the caller up by the context agentId", async () => {
      const h = harness();
      await tool(h, "agent_zed").handler(GOOD);

      expect(h.services.agentRepo.findById).toHaveBeenCalledWith("agent_zed");
    });
  });

  describe("happy path", () => {
    it("creates the container task, dispatches, then inserts the repo_run in that order", async () => {
      const h = harness();
      const result = await tool(h).handler(GOOD);

      expect(result.isError).toBeFalsy();
      // repo_run.session_id FKs to session.id, so dispatch (which writes
      // the session row) must land before the repo_run insert.
      expect(h.order).toEqual(["task.create", "dispatch", "repoRun.create"]);
    });

    it("pins the container task to the resolved agent as both creator and assignee", async () => {
      const h = harness();
      await tool(h).handler(GOOD);

      expect(h.createdTasks[0]).toMatchObject({
        title: GOOD.goal,
        description: GOOD.goal,
        priority: "medium",
        assignee_id: "agent_a",
        creator_id: "agent_a",
        creator_type: "agent",
      });
    });

    it("dispatches a run_repo session carrying the goal as intent", async () => {
      const h = harness();
      await tool(h).handler(GOOD);

      expect(h.dispatches[0]).toMatchObject({
        agentId: "agent_a",
        type: "run_repo",
        intent: GOOD.goal,
        reason: { kind: "fresh" },
      });
    });

    it("reuses the pre-minted session id for both the dispatch and the repo_run", async () => {
      const h = harness();
      const result = await tool(h).handler(GOOD);

      const content = result.content as Record<string, unknown>;
      expect(h.dispatches[0]?.sessionIdOverride).toBe(content.session_id);
      expect(h.repoRuns[0]?.session_id).toBe(content.session_id);
    });

    it("ties the repo_run to the container task and returns pending", async () => {
      const h = harness();
      const result = await tool(h).handler(GOOD);
      const content = result.content as Record<string, unknown>;

      expect(h.repoRuns[0]).toMatchObject({
        id: content.repo_run_id,
        task_id: content.task_id,
        agent_id: "agent_a",
        goal: GOOD.goal,
        repo_url: GOOD.repo_url,
        status: "pending",
      });
      expect(content.status).toBe("pending");
      expect(content.task_id).toBe(h.createdTasks[0]?.id);
    });

    it("returns a watch_url pointing at the new repo_run", async () => {
      const h = harness();
      const result = await tool(h).handler(GOOD);
      const content = result.content as Record<string, unknown>;

      expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    });

    it("echoes input_url and input_filename back, trimmed", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...GOOD,
        input_url: "  https://example.com/report.pdf  ",
        input_filename: "  report.pdf  ",
      });

      expect(result.content).toMatchObject({
        input_url: "https://example.com/report.pdf",
        input_filename: "report.pdf",
      });
    });

    it("leaves input_url and input_filename undefined when not supplied", async () => {
      const h = harness();
      const result = await tool(h).handler(GOOD);
      const content = result.content as Record<string, unknown>;

      expect(content.input_url).toBeUndefined();
      expect(content.input_filename).toBeUndefined();
    });

    it("mints a distinct repo_run, session and task id on each call", async () => {
      const h = harness();
      const a = (await tool(h).handler(GOOD)).content as Record<string, unknown>;
      const b = (await tool(h).handler(GOOD)).content as Record<string, unknown>;

      expect(a.repo_run_id).not.toBe(b.repo_run_id);
      expect(a.session_id).not.toBe(b.session_id);
      expect(a.task_id).not.toBe(b.task_id);
    });
  });

  describe("container task title", () => {
    it("collapses runs of whitespace", async () => {
      const h = harness();
      await tool(h).handler({ ...GOOD, goal: "extract\n\n  the   tables" });

      expect(h.createdTasks[0]?.title).toBe("extract the tables");
    });

    it("truncates a long goal to 80 chars with an ellipsis, leaving description intact", async () => {
      const h = harness();
      const goal = "x".repeat(200);
      await tool(h).handler({ ...GOOD, goal });

      const title = h.createdTasks[0]?.title as string;
      expect(title).toHaveLength(78); // 77 chars + the single ellipsis char
      expect(title.endsWith("…")).toBe(true);
      expect(h.createdTasks[0]?.description).toBe(goal);
    });

    it("leaves an exactly-80-char goal untruncated", async () => {
      const h = harness();
      const goal = "y".repeat(80);
      await tool(h).handler({ ...GOOD, goal });

      expect(h.createdTasks[0]?.title).toBe(goal);
    });
  });

  describe("limits parsing", () => {
    it("returns an empty object when limits are absent", async () => {
      const h = harness();
      const result = await tool(h).handler(GOOD);

      expect(result.content.limits).toEqual({});
    });

    it.each([
      ["a non-object", "20"],
      ["null", null],
    ])("returns an empty object for %s", async (_label, limits) => {
      const h = harness();
      const result = await tool(h).handler({ ...GOOD, limits });

      expect(result.content.limits).toEqual({});
    });

    it("passes through in-range values", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...GOOD,
        limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 512 },
      });

      expect(result.content.limits).toEqual({
        wall_clock_minutes: 15,
        max_install_attempts: 3,
        disk_mb: 512,
      });
    });

    it("clamps each limit to its ceiling", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...GOOD,
        limits: {
          wall_clock_minutes: 999,
          max_install_attempts: 99,
          disk_mb: 999_999,
        },
      });

      expect(result.content.limits).toEqual({
        wall_clock_minutes: 60,
        max_install_attempts: 5,
        disk_mb: 10_000,
      });
    });

    it("floors fractional attempt and disk values", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...GOOD,
        limits: { max_install_attempts: 2.9, disk_mb: 100.7 },
      });

      expect(result.content.limits).toEqual({
        max_install_attempts: 2,
        disk_mb: 100,
      });
    });

    it.each([
      ["zero", 0],
      ["a negative number", -5],
      ["a string", "10"],
    ])("drops %s", async (_label, value) => {
      const h = harness();
      const result = await tool(h).handler({
        ...GOOD,
        limits: {
          wall_clock_minutes: value,
          max_install_attempts: value,
          disk_mb: value,
        },
      });

      expect(result.content.limits).toEqual({});
    });

    it("keeps the valid limits and drops only the invalid ones", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...GOOD,
        limits: { wall_clock_minutes: 10, max_install_attempts: 0, disk_mb: "big" },
      });

      expect(result.content.limits).toEqual({ wall_clock_minutes: 10 });
    });
  });

  describe("failure paths", () => {
    it("reports dispatch_failed and never inserts the repo_run", async () => {
      const h = harness({ dispatchThrows: new Error("no runtime online") });
      const result = await tool(h).handler(GOOD);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "dispatch_failed",
        message: "no runtime online",
      });
      expect(h.order).toEqual(["task.create", "dispatch"]);
      expect(h.repoRuns).toHaveLength(0);
    });

    it("stringifies a non-Error thrown out of dispatch", async () => {
      const h = harness({ dispatchThrows: "boom" });
      const result = await tool(h).handler(GOOD);

      expect(result.content).toMatchObject({
        error: "dispatch_failed",
        message: "boom",
      });
    });

    it("reports repo_run_create_failed when the insert fails after dispatch", async () => {
      const h = harness({ repoRunThrows: new Error("fk violation") });
      const result = await tool(h).handler(GOOD);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({
        error: "repo_run_create_failed",
        message: "fk violation",
      });
      expect(h.order).toEqual(["task.create", "dispatch", "repoRun.create"]);
    });

    it("stringifies a non-Error thrown out of the repo_run insert", async () => {
      const h = harness({ repoRunThrows: { code: "23503" } });
      const result = await tool(h).handler(GOOD);

      expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
      expect(typeof result.content.message).toBe("string");
    });
  });
});
