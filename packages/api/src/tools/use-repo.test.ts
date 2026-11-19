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

interface Harness {
  services: UseRepoServices;
  calls: {
    tasks: Array<Record<string, unknown>>;
    dispatch: Array<Record<string, unknown>>;
    repoRuns: Array<Record<string, unknown>>;
    order: string[];
  };
}

function harness(
  opts: {
    agent?: Agent | undefined;
    dispatchError?: unknown;
    repoRunError?: unknown;
  } = {},
): Harness {
  const calls: Harness["calls"] = {
    tasks: [],
    dispatch: [],
    repoRuns: [],
    order: [],
  };
  const agent =
    "agent" in opts
      ? opts.agent
      : ({ id: "agent_caller", name: "Caller" } as unknown as Agent);

  const agentRepo = {
    findById: vi.fn(async (id: string) => {
      calls.order.push(`findById:${id}`);
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.order.push("task.create");
      calls.tasks.push(input);
      return input as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.order.push("repoRun.create");
      calls.repoRuns.push(input);
      if (opts.repoRunError !== undefined) throw opts.repoRunError;
      return input as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      calls.order.push("dispatch");
      calls.dispatch.push(input);
      if (opts.dispatchError !== undefined) throw opts.dispatchError;
      return {} as never;
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    calls,
  };
}

function tool(h: Harness, agentId = "agent_caller") {
  return createUseRepoTool({ agentId }, h.services);
}

const GOOD = {
  goal: "Extract tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool", () => {
  it("exposes the MCP surface the agent contract promises", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.description).toContain("Docker sandbox");
    expect(t.schema).toMatchObject({
      type: "object",
      required: ["goal", "repo_url"],
      additionalProperties: false,
    });
    const props = (t.schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual([
      "goal",
      "repo_url",
      "input_url",
      "input_filename",
      "limits",
    ]);
  });

  describe("goal validation", () => {
    it.each([
      ["missing", {}],
      ["empty string", { goal: "" }],
      ["whitespace only", { goal: "   \n\t " }],
      ["non-string", { goal: 42 }],
    ])("rejects a %s goal before touching any port", async (_label, patch) => {
      const h = harness();
      const result = await tool(h).handler({ repo_url: GOOD.repo_url, ...patch });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "invalid_goal",
        message: "goal must be a non-empty string",
      });
      expect(h.calls.order).toEqual([]);
    });
  });

  describe("repo_url validation", () => {
    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["plain http", "http://github.com/foo/bar"],
      ["a non-GitHub host", "https://gitlab.com/foo/bar"],
      ["a host merely containing github.com", "https://github.com.evil.test/foo"],
      ["not a URL at all", "github.com/foo/bar"],
      ["an ssh remote", "git@github.com:foo/bar.git"],
    ])("rejects %s", async (_label, repoUrl) => {
      const h = harness();
      const result = await tool(h).handler({
        goal: GOOD.goal,
        ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "invalid_repo_url",
        message: "repo_url must be a GitHub HTTPS URL",
      });
      expect(h.calls.order).toEqual([]);
    });

    it.each([
      "https://github.com/jsvine/pdfplumber",
      "https://GitHub.com/jsvine/pdfplumber",
      "https://www.github.com/jsvine/pdfplumber",
      "https://gist.github.com/someone/abc123",
    ])("accepts %s", async (repoUrl) => {
      const h = harness();
      const result = await tool(h).handler({ goal: GOOD.goal, repo_url: repoUrl });
      expect(result.isError).toBeFalsy();
      expect(h.calls.repoRuns[0]).toMatchObject({ repo_url: repoUrl });
    });

    it("trims surrounding whitespace off goal and repo_url", async () => {
      const h = harness();
      await tool(h).handler({
        goal: "  summarize the readme  ",
        repo_url: `  ${GOOD.repo_url}  `,
      });

      expect(h.calls.repoRuns[0]).toMatchObject({
        goal: "summarize the readme",
        repo_url: GOOD.repo_url,
      });
    });
  });

  it("refuses when the calling agent no longer exists", async () => {
    const h = harness({ agent: undefined });
    const result = await tool(h, "agent_ghost").handler({ ...GOOD });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "agent_not_found",
      message: "calling agent not found",
    });
    expect(h.calls.order).toEqual(["findById:agent_ghost"]);
  });

  it("creates the container task, dispatches, then inserts the repo_run — in that order", async () => {
    const h = harness();
    const result = await tool(h).handler({ ...GOOD });

    // The FK on repo_run.session_id means dispatch (which writes the
    // session row) has to land before the repo_run insert.
    expect(h.calls.order).toEqual([
      "findById:agent_caller",
      "task.create",
      "dispatch",
      "repoRun.create",
    ]);

    expect(h.calls.tasks[0]).toMatchObject({
      title: GOOD.goal,
      description: GOOD.goal,
      priority: "medium",
      assignee_id: "agent_caller",
      creator_id: "agent_caller",
      creator_type: "agent",
    });

    const content = result.content as Record<string, string>;
    expect(h.calls.dispatch[0]).toMatchObject({
      agentId: "agent_caller",
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
      sessionIdOverride: content.session_id,
    });
    expect(h.calls.dispatch[0]?.task).toBe(h.calls.tasks[0]);
  });

  it("returns ids that match the rows it wrote", async () => {
    const h = harness();
    const result = await tool(h).handler({ ...GOOD });

    const content = result.content as Record<string, unknown>;
    const run = h.calls.repoRuns[0] as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(content.repo_run_id).toBe(run.id);
    expect(content.session_id).toBe(run.session_id);
    expect(content.task_id).toBe(run.task_id);
    expect(content.status).toBe("pending");
    expect(run.status).toBe("pending");
    expect(run.agent_id).toBe("agent_caller");
    expect(content.watch_url).toBe(`/capabilities/runs/${String(run.id)}`);
    expect(content.note).toContain("Sandbox run started");
    expect(String(content.repo_run_id)).toMatch(/^repo_/);
    expect(String(content.session_id)).toMatch(/^sess_/);
  });

  it("mints a fresh id trio on every call", async () => {
    const h = harness();
    const a = (await tool(h).handler({ ...GOOD })).content as Record<string, string>;
    const b = (await tool(h).handler({ ...GOOD })).content as Record<string, string>;

    expect(a.repo_run_id).not.toBe(b.repo_run_id);
    expect(a.session_id).not.toBe(b.session_id);
    expect(a.task_id).not.toBe(b.task_id);
  });

  describe("container task title", () => {
    it("collapses runs of whitespace", async () => {
      const h = harness();
      await tool(h).handler({
        goal: "extract\n\n  the   tables\tplease",
        repo_url: GOOD.repo_url,
      });
      expect(h.calls.tasks[0]?.title).toBe("extract the tables please");
    });

    it("keeps an 80-char goal whole", async () => {
      const h = harness();
      const goal = "x".repeat(80);
      await tool(h).handler({ goal, repo_url: GOOD.repo_url });
      expect(h.calls.tasks[0]?.title).toBe(goal);
    });

    it("truncates past 80 chars to 77 plus an ellipsis", async () => {
      const h = harness();
      const goal = "y".repeat(200);
      await tool(h).handler({ goal, repo_url: GOOD.repo_url });

      const title = h.calls.tasks[0]?.title as string;
      expect(title).toBe("y".repeat(77) + "…");
      expect(title).toHaveLength(78);
      // The untruncated goal still reaches the description and repo_run.
      expect(h.calls.tasks[0]?.description).toBe(goal);
      expect(h.calls.repoRuns[0]?.goal).toBe(goal);
    });
  });

  describe("input_url / input_filename", () => {
    it("echoes both back trimmed", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...GOOD,
        input_url: "  https://example.test/a.pdf  ",
        input_filename: "  a.pdf  ",
      });

      expect(result.content).toMatchObject({
        input_url: "https://example.test/a.pdf",
        input_filename: "a.pdf",
      });
    });

    it("leaves them undefined when absent or not strings", async () => {
      const h = harness();
      const result = await tool(h).handler({
        ...GOOD,
        input_filename: 7,
      });

      const content = result.content as Record<string, unknown>;
      expect(content.input_url).toBeUndefined();
      expect(content.input_filename).toBeUndefined();
    });
  });

  describe("limits parsing", () => {
    async function limitsFor(raw: unknown): Promise<Record<string, number>> {
      const h = harness();
      const result = await tool(h).handler({ ...GOOD, limits: raw });
      return (result.content as { limits: Record<string, number> }).limits;
    }

    it("passes sane values through untouched", async () => {
      expect(
        await limitsFor({
          wall_clock_minutes: 15,
          max_install_attempts: 3,
          disk_mb: 4096,
        }),
      ).toEqual({
        wall_clock_minutes: 15,
        max_install_attempts: 3,
        disk_mb: 4096,
      });
    });

    it("clamps each ceiling", async () => {
      expect(
        await limitsFor({
          wall_clock_minutes: 999,
          max_install_attempts: 50,
          disk_mb: 1_000_000,
        }),
      ).toEqual({
        wall_clock_minutes: 60,
        max_install_attempts: 5,
        disk_mb: 10_000,
      });
    });

    it("floors fractional counts", async () => {
      expect(
        await limitsFor({ max_install_attempts: 2.9, disk_mb: 100.7 }),
      ).toEqual({ max_install_attempts: 2, disk_mb: 100 });
    });

    it.each([
      ["zero", 0],
      ["negative", -5],
      ["a string", "20"],
      ["null", null],
    ])("drops a %s wall_clock_minutes", async (_label, value) => {
      expect(await limitsFor({ wall_clock_minutes: value })).toEqual({});
    });

    it.each([
      ["omitted", undefined],
      ["null", null],
      ["a string", "big"],
      ["a number", 5],
    ])("yields {} when limits is %s", async (_label, raw) => {
      expect(await limitsFor(raw)).toEqual({});
    });

    it("keeps the valid keys when a sibling is invalid", async () => {
      expect(
        await limitsFor({ wall_clock_minutes: 10, disk_mb: -1 }),
      ).toEqual({ wall_clock_minutes: 10 });
    });
  });

  describe("failure surfaces", () => {
    it("reports dispatch_failed and never inserts the repo_run", async () => {
      const h = harness({ dispatchError: new Error("no daemon online") });
      const result = await tool(h).handler({ ...GOOD });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "dispatch_failed",
        message: "no daemon online",
      });
      expect(h.calls.repoRuns).toEqual([]);
    });

    it("stringifies a non-Error dispatch throw", async () => {
      const h = harness({ dispatchError: "boom" });
      const result = await tool(h).handler({ ...GOOD });

      expect(result.content).toEqual({
        error: "dispatch_failed",
        message: "boom",
      });
    });

    it("reports repo_run_create_failed so the agent does not wait on an orphan session", async () => {
      const h = harness({ repoRunError: new Error("fk violation") });
      const result = await tool(h).handler({ ...GOOD });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "repo_run_create_failed",
        message: "fk violation",
      });
      expect(h.calls.dispatch).toHaveLength(1);
    });

    it("stringifies a non-Error repo_run throw", async () => {
      const h = harness({ repoRunError: { code: 23503 } });
      const result = await tool(h).handler({ ...GOOD });

      expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
      expect(typeof (result.content as { message: unknown }).message).toBe("string");
    });
  });
});
