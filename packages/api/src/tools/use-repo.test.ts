/**
 * use_repo handler tests.
 *
 * The tool mints three rows across two repos plus a dispatch, in an
 * order that matters (repo_run.session_id FKs to session.id, which
 * dispatchTask creates). Fakes stand in for all four collaborators so
 * the ordering, the limit clamps and every failure envelope are
 * checkable without Docker or Postgres.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const GOOD_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

interface Fakes {
  services: UseRepoServices;
  calls: string[];
  taskCreateArgs: Record<string, unknown>[];
  repoRunCreateArgs: Record<string, unknown>[];
  dispatchArgs: Record<string, unknown>[];
}

function fakes(
  opts: {
    agentMissing?: boolean;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Fakes {
  // One shared log so assertions can pin the *relative* order of the
  // dispatch and the repo_run insert, not just that both happened.
  const calls: string[] = [];
  const taskCreateArgs: Record<string, unknown>[] = [];
  const repoRunCreateArgs: Record<string, unknown>[] = [];
  const dispatchArgs: Record<string, unknown>[] = [];

  const agentRepo = {
    findById: vi.fn(async (id: string) => {
      calls.push("agent.findById");
      return opts.agentMissing ? null : { id, hierarchy_level: "ic" };
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      calls.push("task.create");
      taskCreateArgs.push(row);
      return row;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      calls.push("repoRun.create");
      if (opts.repoRunThrows) throw opts.repoRunThrows;
      repoRunCreateArgs.push(row);
      return row;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (args: Record<string, unknown>) => {
      calls.push("dispatch");
      if (opts.dispatchThrows) throw opts.dispatchThrows;
      dispatchArgs.push(args);
      return { sessionId: args.sessionIdOverride };
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    calls,
    taskCreateArgs,
    repoRunCreateArgs,
    dispatchArgs,
  };
}

function tool(f: Fakes) {
  return createUseRepoTool({ agentId: "agent_a" }, f.services);
}

describe("use_repo descriptor", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(fakes());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
  });

  it("closes the input to unknown top-level keys", () => {
    // additionalProperties:false is what stops an agent from smuggling
    // extra fields past the schema into the handler.
    expect(tool(fakes()).schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a blank or non-string goal before any write", async () => {
    for (const goal of ["", "   ", 7, undefined, null]) {
      const f = fakes();
      const result = await tool(f).handler({ ...GOOD_INPUT, goal });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
      expect(f.calls).toEqual([]);
    }
  });

  it("accepts a GitHub HTTPS url, including a subdomain", async () => {
    for (const repo_url of [
      "https://github.com/jsvine/pdfplumber",
      "https://www.github.com/jsvine/pdfplumber",
      "https://GitHub.com/jsvine/pdfplumber",
      "  https://github.com/jsvine/pdfplumber  ",
    ]) {
      const f = fakes();
      const result = await tool(f).handler({ ...GOOD_INPUT, repo_url });
      expect(result.isError).toBeFalsy();
    }
  });

  it("refuses a non-GitHub host", async () => {
    // The sandbox clones whatever it is handed, so host checking is the
    // only thing keeping the run on GitHub.
    for (const repo_url of [
      "https://gitlab.com/foo/bar",
      "https://notgithub.com/foo/bar",
      "https://github.com.evil.io/foo/bar",
    ]) {
      const f = fakes();
      const result = await tool(f).handler({ ...GOOD_INPUT, repo_url });

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
      expect(f.calls).toEqual([]);
    }
  });

  it("refuses a non-HTTPS scheme even on github.com", async () => {
    for (const repo_url of [
      "http://github.com/foo/bar",
      "git://github.com/foo/bar",
      "ssh://git@github.com/foo/bar",
    ]) {
      const f = fakes();
      const result = await tool(f).handler({ ...GOOD_INPUT, repo_url });
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    }
  });

  it("refuses an unparseable or missing repo_url", async () => {
    for (const repo_url of ["not a url", "", "   ", 7, undefined]) {
      const f = fakes();
      const result = await tool(f).handler({ ...GOOD_INPUT, repo_url });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    }
  });
});

describe("use_repo happy path", () => {
  it("returns the three minted ids plus a pending status and watch url", async () => {
    const f = fakes();
    const result = await tool(f).handler(GOOD_INPUT);

    expect(result.isError).toBeFalsy();
    const c = result.content as Record<string, string>;
    expect(c.status).toBe("pending");
    expect(c.repo_run_id).toBeTruthy();
    expect(c.session_id).toBeTruthy();
    expect(c.task_id).toBeTruthy();
    expect(c.watch_url).toBe(`/capabilities/runs/${c.repo_run_id}`);
  });

  it("creates the session before the repo_run that references it", async () => {
    // repo_run.session_id has an FK to session.id; dispatchTask is what
    // creates that session row. Inverting these two breaks the insert.
    const f = fakes();
    await tool(f).handler(GOOD_INPUT);

    expect(f.calls).toEqual([
      "agent.findById",
      "task.create",
      "dispatch",
      "repoRun.create",
    ]);
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const f = fakes();
    const result = await tool(f).handler(GOOD_INPUT);
    const c = result.content as Record<string, string>;

    expect(f.dispatchArgs[0]).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: GOOD_INPUT.goal,
      reason: { kind: "fresh" },
      sessionIdOverride: c.session_id,
    });
  });

  it("pins the container task to the resolved agent as both creator and assignee", async () => {
    const f = fakes();
    await tool(f).handler(GOOD_INPUT);

    expect(f.taskCreateArgs[0]).toMatchObject({
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
      priority: "medium",
      description: GOOD_INPUT.goal,
    });
  });

  it("writes the repo_run row tying the session and task together", async () => {
    const f = fakes();
    const result = await tool(f).handler(GOOD_INPUT);
    const c = result.content as Record<string, string>;

    expect(f.repoRunCreateArgs[0]).toMatchObject({
      id: c.repo_run_id,
      session_id: c.session_id,
      task_id: c.task_id,
      agent_id: "agent_a",
      goal: GOOD_INPUT.goal,
      repo_url: GOOD_INPUT.repo_url,
      status: "pending",
    });
  });

  it("trims the repo_url before storing it", async () => {
    const f = fakes();
    await tool(f).handler({
      ...GOOD_INPUT,
      repo_url: "  https://github.com/jsvine/pdfplumber  ",
    });

    expect(f.repoRunCreateArgs[0]?.repo_url).toBe(
      "https://github.com/jsvine/pdfplumber",
    );
  });
});

describe("use_repo container task title", () => {
  it("collapses whitespace in the goal", async () => {
    const f = fakes();
    await tool(f).handler({
      ...GOOD_INPUT,
      goal: "Extract\n  the   tables\tas JSON",
    });

    expect(f.taskCreateArgs[0]?.title).toBe("Extract the tables as JSON");
  });

  it("truncates a goal over 80 chars with an ellipsis, leaving description whole", async () => {
    const f = fakes();
    const goal = "x".repeat(200);
    await tool(f).handler({ ...GOOD_INPUT, goal });

    // 77 kept + the ellipsis = 78. The cut is `slice(0, 77) + "…"`, so the
    // result sits two under the 80 the comment describes; pinned as-is
    // because it's an inbox row label and nothing parses the length.
    const title = f.taskCreateArgs[0]?.title as string;
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
    // The full goal still has to reach the child agent.
    expect(f.taskCreateArgs[0]?.description).toBe(goal);
  });

  it("leaves a goal of exactly 80 chars untruncated", async () => {
    const f = fakes();
    const goal = "y".repeat(80);
    await tool(f).handler({ ...GOOD_INPUT, goal });

    expect(f.taskCreateArgs[0]?.title).toBe(goal);
  });
});

describe("use_repo optional input file", () => {
  it("echoes a trimmed input_url and input_filename back to the agent", async () => {
    const f = fakes();
    const result = await tool(f).handler({
      ...GOOD_INPUT,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves both undefined when not supplied", async () => {
    const f = fakes();
    const result = await tool(f).handler(GOOD_INPUT);
    const c = result.content as Record<string, unknown>;

    expect(c.input_url).toBeUndefined();
    expect(c.input_filename).toBeUndefined();
  });
});

describe("use_repo limit clamping", () => {
  it("passes through in-range limits", async () => {
    const f = fakes();
    const result = await tool(f).handler({
      ...GOOD_INPUT,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 },
    });

    expect(result.content).toMatchObject({
      limits: {
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 512,
      },
    });
  });

  it("caps each limit at its documented ceiling", async () => {
    // An agent asking for a 10-hour, 100GB run gets the ceiling, not a
    // refusal — the clamp is the enforcement point.
    const f = fakes();
    const result = await tool(f).handler({
      ...GOOD_INPUT,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 100_000,
      },
    });

    expect(result.content).toMatchObject({
      limits: {
        wall_clock_minutes: 60,
        max_install_attempts: 5,
        disk_mb: 10_000,
      },
    });
  });

  it("floors fractional attempt and disk values", async () => {
    const f = fakes();
    const result = await tool(f).handler({
      ...GOOD_INPUT,
      limits: { max_install_attempts: 2.9, disk_mb: 1024.7 },
    });

    expect(result.content).toMatchObject({
      limits: { max_install_attempts: 2, disk_mb: 1024 },
    });
  });

  it("drops non-positive and non-numeric limits so defaults apply", async () => {
    const f = fakes();
    const result = await tool(f).handler({
      ...GOOD_INPUT,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "lots",
      },
    });

    expect(result.content).toMatchObject({ limits: {} });
  });

  it("treats a missing or non-object limits as empty", async () => {
    for (const limits of [undefined, null, "20", 20, []]) {
      const f = fakes();
      const result = await tool(f).handler({ ...GOOD_INPUT, limits });
      expect(result.content).toMatchObject({ limits: {} });
    }
  });
});

describe("use_repo failure envelopes", () => {
  it("reports agent_not_found and writes nothing", async () => {
    const f = fakes({ agentMissing: true });
    const result = await tool(f).handler(GOOD_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // The container task must not be left behind by a failed lookup.
    expect(f.calls).toEqual(["agent.findById"]);
  });

  it("reports dispatch_failed with the cause and skips the repo_run insert", async () => {
    const f = fakes({ dispatchThrows: new Error("no daemon online") });
    const result = await tool(f).handler(GOOD_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(f.calls).not.toContain("repoRun.create");
  });

  it("reports repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    // The session row already landed here; composeDispatchPayload will
    // find no repo_run and fail it. Silence would leave the agent
    // waiting forever on a run that can never report.
    const f = fakes({ repoRunThrows: new Error("duplicate key") });
    const result = await tool(f).handler(GOOD_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error throw from either write", async () => {
    const dispatch = await tool(fakes({ dispatchThrows: "boom" })).handler(
      GOOD_INPUT,
    );
    expect(dispatch.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });

    const repoRun = await tool(fakes({ repoRunThrows: "splat" })).handler(
      GOOD_INPUT,
    );
    expect(repoRun.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "splat",
    });
  });
});
