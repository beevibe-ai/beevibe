/**
 * use_repo handler tests.
 *
 * The tool is the Capability Network's verb (#149) and its handler owns
 * three things no other layer re-checks: input validation (goal +
 * GitHub-only repo_url), the limits clamp, and the ordered
 * dispatch-then-insert dance whose failure modes each get their own
 * error code. All four collaborators are ports, so plain fakes cover
 * the whole surface without Postgres or a daemon.
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

interface Harness {
  services: UseRepoServices;
  dispatched: Array<Record<string, unknown>>;
  createdTasks: Array<Record<string, unknown>>;
  createdRuns: Array<Record<string, unknown>>;
}

function harness(
  overrides: {
    agent?: Agent | undefined;
    dispatchError?: unknown;
    repoRunError?: unknown;
  } = {},
): Harness {
  const dispatched: Array<Record<string, unknown>> = [];
  const createdTasks: Array<Record<string, unknown>> = [];
  const createdRuns: Array<Record<string, unknown>> = [];

  const agent =
    "agent" in overrides
      ? overrides.agent
      : ({ id: AGENT_ID, name: "Caller" } as unknown as Agent);

  const agentRepo = {
    findById: vi.fn(async () => agent),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      createdTasks.push(row);
      return row as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      if (overrides.repoRunError) throw overrides.repoRunError;
      createdRuns.push(row);
      return row as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.dispatchError) throw overrides.dispatchError;
      dispatched.push(input);
      return {} as never;
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    dispatched,
    createdTasks,
    createdRuns,
  };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: AGENT_ID }, h.services);
}

describe("use_repo — input validation", () => {
  it("rejects a missing, blank, or non-string goal before touching any port", async () => {
    for (const goal of [undefined, "", "   ", 42]) {
      const h = harness();
      const result = await tool(h).handler({
        goal,
        repo_url: "https://github.com/acme/tool",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
      // Validation is pre-flight: nothing was created or dispatched.
      expect(h.services.agentRepo.findById).not.toHaveBeenCalled();
      expect(h.createdTasks).toHaveLength(0);
      expect(h.dispatched).toHaveLength(0);
    }
  });

  it("rejects repo_url that is absent, unparseable, non-https, or not GitHub", async () => {
    const bad = [
      undefined,
      "",
      "   ",
      7,
      "not a url",
      "http://github.com/acme/tool", // http, not https
      "https://gitlab.com/acme/tool",
      "https://notgithub.com/acme/tool", // must not match the suffix loosely
      "https://github.com.evil.test/acme/tool",
    ];
    for (const repo_url of bad) {
      const h = harness();
      const result = await tool(h).handler({ goal: "extract tables", repo_url });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
      expect(h.dispatched).toHaveLength(0);
    }
  });

  it("accepts github.com and its subdomains over https", async () => {
    for (const repo_url of [
      "https://github.com/acme/tool",
      "https://www.github.com/acme/tool",
      "https://GitHub.com/acme/tool",
    ]) {
      const h = harness();
      const result = await tool(h).handler({ goal: "extract tables", repo_url });
      expect(result.isError).toBeFalsy();
    }
  });

  it("returns agent_not_found when the calling agent row is gone", async () => {
    const h = harness({ agent: undefined });
    const result = await tool(h).handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.createdTasks).toHaveLength(0);
  });
});

describe("use_repo — happy path", () => {
  it("creates the container task, dispatches, inserts the repo_run, and returns the ids", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "  Extract the tables from this PDF as JSON  ",
      repo_url: "  https://github.com/jsvine/pdfplumber  ",
      input_url: " https://example.test/doc.pdf ",
      input_filename: " doc.pdf ",
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Record<string, string>;

    // Container task: trimmed goal as both title and description, with the
    // caller pinned as creator *and* assignee.
    expect(h.createdTasks).toHaveLength(1);
    expect(h.createdTasks[0]).toMatchObject({
      title: "Extract the tables from this PDF as JSON",
      description: "Extract the tables from this PDF as JSON",
      priority: "medium",
      assignee_id: AGENT_ID,
      creator_id: AGENT_ID,
      creator_type: "agent",
    });

    // Dispatch carries the run_repo type and the pre-minted session id.
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      agentId: AGENT_ID,
      type: "run_repo",
      intent: "Extract the tables from this PDF as JSON",
      reason: { kind: "fresh" },
      sessionIdOverride: content.session_id,
    });

    // repo_run row reuses that same session id (its FK target) and the
    // container task id.
    expect(h.createdRuns).toHaveLength(1);
    expect(h.createdRuns[0]).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: AGENT_ID,
      goal: "Extract the tables from this PDF as JSON",
      repo_url: "https://github.com/jsvine/pdfplumber",
      status: "pending",
    });

    expect(result.content).toMatchObject({
      status: "pending",
      watch_url: `/capabilities/runs/${content.repo_run_id}`,
      input_url: "https://example.test/doc.pdf",
      input_filename: "doc.pdf",
    });
    expect(result.content.note).toContain("Sandbox run started");
  });

  it("dispatches before inserting the repo_run — the FK requires that order", async () => {
    const order: string[] = [];
    const h = harness();
    (h.services.dispatchService.dispatchTask as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("dispatch");
        return {} as never;
      },
    );
    (h.services.repoRunRepo.create as ReturnType<typeof vi.fn>).mockImplementation(
      async (row: unknown) => {
        order.push("repo_run");
        return row;
      },
    );

    await tool(h).handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });

    expect(order).toEqual(["dispatch", "repo_run"]);
  });

  it("omits input_url / input_filename when not supplied or not strings", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
      input_url: 99,
    });
    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });

  it("truncates a long goal to 80 chars for the task title but keeps it whole as the description", async () => {
    const h = harness();
    const goal = "x".repeat(200);
    await tool(h).handler({ goal, repo_url: "https://github.com/acme/tool" });

    const title = h.createdTasks[0]?.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(h.createdTasks[0]?.description).toBe(goal);
  });

  it("collapses runs of whitespace in the title", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "extract\n\ttables   from   the  PDF",
      repo_url: "https://github.com/acme/tool",
    });
    expect(h.createdTasks[0]?.title).toBe("extract tables from the PDF");
  });

  it("mints a distinct session id and repo_run id on each call", async () => {
    const h = harness();
    const a = await tool(h).handler({
      goal: "one",
      repo_url: "https://github.com/acme/tool",
    });
    const b = await tool(h).handler({
      goal: "two",
      repo_url: "https://github.com/acme/tool",
    });
    expect(a.content.session_id).not.toBe(b.content.session_id);
    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
  });
});

describe("use_repo — limits clamp", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, number>> {
    const h = harness();
    const result = await tool(h).handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
      limits,
    });
    return result.content.limits as Record<string, number>;
  }

  it("passes sane values through untouched", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 });
  });

  it("caps each limit at its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 10_000,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors fractional counts and sizes", async () => {
    expect(await limitsFor({ max_install_attempts: 2.9, disk_mb: 100.7 })).toEqual({
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it("drops non-positive and non-numeric entries rather than clamping them up", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      }),
    ).toEqual({});
  });

  it("treats a missing or non-object limits field as no limits", async () => {
    expect(await limitsFor(undefined)).toEqual({});
    expect(await limitsFor(null)).toEqual({});
    expect(await limitsFor("20")).toEqual({});
  });
});

describe("use_repo — failure modes", () => {
  it("returns dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const h = harness({ dispatchError: new Error("daemon offline") });
    const result = await tool(h).handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(h.services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchError: "boom" });
    const result = await tool(h).handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const h = harness({ repoRunError: new Error("fk violation") });
    const result = await tool(h).handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
    // The session was already dispatched — that's the orphan the code
    // documents and self-recovers from.
    expect(h.dispatched).toHaveLength(1);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunError: { code: "23503" } });
    const result = await tool(h).handler({
      goal: "extract tables",
      repo_url: "https://github.com/acme/tool",
    });
    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof result.content.message).toBe("string");
  });
});

describe("use_repo — tool metadata", () => {
  it("exposes goal + repo_url as the only required schema fields", () => {
    const t = tool(harness());
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

  it("tells the agent sandboxed installs are not host installs", () => {
    // The description is the agent-facing contract: this sentence is why
    // an agent reaches for use_repo instead of reporting an install
    // blocker. Worth locking.
    expect(tool(harness()).description).toContain("NOT system installs");
  });
});
