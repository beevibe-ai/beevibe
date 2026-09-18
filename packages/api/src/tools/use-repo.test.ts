/**
 * use_repo handler tests.
 *
 * The tool's job is ordering and guarding, not sandboxing: validate the
 * goal + repo_url, confirm the caller exists, create the container task,
 * dispatch (which mints the session row) and only then insert the
 * repo_run — repo_run.session_id has an FK to session.id, so the order is
 * load-bearing. Fakes stand in for every repo so this stays off Postgres
 * and off Docker; what's asserted is the sequence and the failure
 * envelopes at each step.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

interface Harness {
  services: UseRepoServices;
  findById: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  createRepoRun: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  order: string[];
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const order: string[] = [];

  const findById =
    overrides.findById ??
    vi.fn(async (id: string) => ({ id, name: "Borrower" }));
  const createTask =
    overrides.createTask ??
    vi.fn(async (row: Record<string, unknown>) => ({ ...row }));
  const createRepoRun = overrides.createRepoRun ?? vi.fn(async () => undefined);
  const dispatchTask = overrides.dispatchTask ?? vi.fn(async () => undefined);

  const track =
    (label: string, fn: ReturnType<typeof vi.fn>) =>
    async (...args: unknown[]) => {
      order.push(label);
      return fn(...args);
    };

  const services = {
    agentRepo: { findById: track("agent", findById) } as unknown as AgentRepository,
    taskRepo: { create: track("task", createTask) } as unknown as TaskRepository,
    repoRunRepo: {
      create: track("repo_run", createRepoRun),
    } as unknown as RepoRunRepository,
    dispatchService: {
      dispatchTask: track("dispatch", dispatchTask),
    } as unknown as DispatchService,
  };

  return { services, findById, createTask, createRepoRun, dispatchTask, order };
}

const ctx = { agentId: "agent_a" };

describe("use_repo happy path", () => {
  it("creates the task, dispatches, then inserts the repo_run — in that order", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Extract tables from this PDF as JSON",
      repo_url: "https://github.com/jsvine/pdfplumber",
    });

    // repo_run.session_id FKs to session.id, and dispatch is what mints
    // the session row — inserting the repo_run first would blow up on the
    // constraint.
    expect(h.order).toEqual(["agent", "task", "dispatch", "repo_run"]);
    expect(result.isError).toBeFalsy();

    const content = result.content as Record<string, string>;
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    expect(content.repo_run_id).toBeTruthy();
    expect(content.session_id).toBeTruthy();
    expect(content.task_id).toBeTruthy();
  });

  it("pins the container task to the resolved agent on both creator and assignee", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    await tool.handler({
      goal: "  Download the audio track  ",
      repo_url: "https://github.com/yt-dlp/yt-dlp",
    });

    expect(h.createTask.mock.calls[0]?.[0]).toMatchObject({
      title: "Download the audio track",
      description: "Download the audio track",
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });
  });

  it("dispatches a run_repo session under the same pre-minted session id it returns", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Run the linter",
      repo_url: "https://github.com/acme/tool",
    });
    const sessionId = (result.content as Record<string, string>).session_id;

    const dispatched = h.dispatchTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(dispatched).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: "Run the linter",
      reason: { kind: "fresh" },
      sessionIdOverride: sessionId,
    });

    // The repo_run row has to reference that same session, not a new one.
    expect(h.createRepoRun.mock.calls[0]?.[0]).toMatchObject({
      session_id: sessionId,
      agent_id: "agent_a",
      goal: "Run the linter",
      repo_url: "https://github.com/acme/tool",
      status: "pending",
    });
  });

  it("truncates a long goal for the task title but keeps it whole as the description", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);
    const goal = "x".repeat(200);

    await tool.handler({ goal, repo_url: "https://github.com/acme/tool" });

    const row = h.createTask.mock.calls[0]?.[0] as { title: string; description: string };
    expect(row.title).toHaveLength(78); // 77 chars + the ellipsis
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.description).toBe(goal);
  });

  it("collapses runs of whitespace in the title", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    await tool.handler({
      goal: "Extract\n\ttables   from  the PDF",
      repo_url: "https://github.com/acme/tool",
    });

    expect(h.createTask.mock.calls[0]?.[0]).toMatchObject({
      title: "Extract tables from the PDF",
    });
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing, blank, or non-string goal without touching any repo", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    for (const goal of [undefined, "", "   ", 42]) {
      const result = await tool.handler({
        goal,
        repo_url: "https://github.com/acme/tool",
      } as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(h.order).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["not a url", "not a url at all"],
    ["http, not https", "http://github.com/acme/tool"],
    ["another host", "https://gitlab.com/acme/tool"],
    ["host merely containing github.com", "https://github.com.evil.example/acme/tool"],
    ["ssh remote", "git@github.com:acme/tool.git"],
  ])("rejects a repo_url that is %s", async (_label, repoUrl) => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Do the thing",
      repo_url: repoUrl,
    } as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.order).toEqual([]);
  });

  it("accepts a github.com subdomain over https", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Do the thing",
      repo_url: "https://www.github.com/acme/tool",
    });

    expect(result.isError).toBeFalsy();
  });

  it("fails with agent_not_found when the caller does not resolve", async () => {
    const h = harness({ findById: vi.fn(async () => null) });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // Nothing is written when the caller is unknown.
    expect(h.order).toEqual(["agent"]);
  });
});

describe("use_repo limits parsing", () => {
  it("passes through valid limits, clamped to the documented ceilings", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Do the thing",
      repo_url: "https://github.com/acme/tool",
      limits: { wall_clock_minutes: 999, max_install_attempts: 99, disk_mb: 99_999 },
    });

    expect((result.content as Record<string, unknown>).limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Do the thing",
      repo_url: "https://github.com/acme/tool",
      limits: { max_install_attempts: 3.9, disk_mb: 512.7 },
    });

    expect((result.content as Record<string, unknown>).limits).toEqual({
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it.each([
    ["absent", undefined],
    ["not an object", "20"],
    ["null", null],
    ["all non-positive", { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: 0 }],
    ["all wrong types", { wall_clock_minutes: "10", max_install_attempts: null, disk_mb: [] }],
  ])("drops limits that are %s", async (_label, limits) => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Do the thing",
      repo_url: "https://github.com/acme/tool",
      limits,
    } as Record<string, unknown>);

    expect((result.content as Record<string, unknown>).limits).toEqual({});
  });
});

describe("use_repo optional input file", () => {
  it("echoes a trimmed input_url and input_filename back to the agent", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Extract tables",
      repo_url: "https://github.com/acme/tool",
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("leaves them undefined when absent or the wrong type", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Extract tables",
      repo_url: "https://github.com/acme/tool",
      input_url: 42,
    });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo failure envelopes", () => {
  it("reports dispatch_failed and never inserts the repo_run", async () => {
    const h = harness({
      dispatchTask: vi.fn(async () => {
        throw new Error("no daemon online");
      }),
    });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(h.createRepoRun).not.toHaveBeenCalled();
  });

  it("reports repo_run_create_failed rather than letting the agent wait on an orphan session", async () => {
    const h = harness({
      createRepoRun: vi.fn(async () => {
        throw new Error("duplicate key");
      }),
    });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "Do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error throw from either write", async () => {
    for (const key of ["dispatchTask", "createRepoRun"] as const) {
      const h = harness({
        [key]: vi.fn(async () => {
          throw "plain string blowup";
        }),
      });
      const tool = createUseRepoTool(ctx, h.services);

      const result = await tool.handler({
        goal: "Do the thing",
        repo_url: "https://github.com/acme/tool",
      });

      expect(result.isError).toBe(true);
      expect(result.content.message).toBe("plain string blowup");
    }
  });
});

describe("use_repo tool surface", () => {
  it("requires goal + repo_url and refuses unknown top-level properties", () => {
    const tool = createUseRepoTool(ctx, harness().services);

    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});
