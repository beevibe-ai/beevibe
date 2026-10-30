/**
 * use_repo tool tests — validation, the two-step dispatch→repo_run write
 * order, limit clamping, and the error envelope for each failure point.
 *
 * The handler is a pure function of its injected services, so the real
 * sandbox orchestrator never runs here. What matters and is locked below:
 *   - the session id handed to dispatchTask is the SAME one stamped on the
 *     repo_run row (the FK ordering comment in the module depends on it),
 *   - a failed repo_run insert still reports the orphan rather than
 *     pretending the run started.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent, RepoRun, Task } from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import {
  createUseRepoTool,
  type UseRepoServices,
} from "./use-repo.js";

function fakeAgent(id = "agent_a"): Agent {
  return { id, name: "A", hierarchy_level: "ic" } as unknown as Agent;
}

interface Harness {
  services: UseRepoServices;
  calls: {
    taskCreate: Record<string, unknown>[];
    dispatch: Record<string, unknown>[];
    repoRunCreate: Record<string, unknown>[];
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
    taskCreate: [],
    dispatch: [],
    repoRunCreate: [],
  };
  const agent = "agent" in opts ? opts.agent : fakeAgent();

  const services = {
    agentRepo: {
      findById: vi.fn(async () => agent),
    },
    taskRepo: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        calls.taskCreate.push(input);
        return input as unknown as Task;
      }),
    },
    repoRunRepo: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        calls.repoRunCreate.push(input);
        if (opts.repoRunError) throw opts.repoRunError;
        return input as unknown as RepoRun;
      }),
    },
    dispatchService: {
      dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
        calls.dispatch.push(input);
        if (opts.dispatchError) throw opts.dispatchError;
        return { session: {}, runtime_id: null };
      }),
    } as unknown as DispatchService,
  } as unknown as UseRepoServices;

  return { services, calls };
}

function build(opts?: Parameters<typeof harness>[0]) {
  const h = harness(opts);
  return { tool: createUseRepoTool({ agentId: "agent_a" }, h.services), ...h };
}

describe("use_repo tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { tool } = build();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing or blank goal before touching any service", async () => {
    const { tool, services } = build();
    for (const goal of [undefined, "", "   ", 42]) {
      const result = await tool.handler({ goal, repo_url: "https://github.com/a/b" });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["http, not https", "http://github.com/a/b"],
    ["a non-GitHub host", "https://gitlab.com/a/b"],
    ["a lookalike host", "https://github.com.evil.test/a/b"],
    ["unparseable", "not a url"],
    ["not a string", 7],
  ])("rejects repo_url that is %s", async (_label, repo_url) => {
    const { tool } = build();
    const result = await tool.handler({ goal: "do a thing", repo_url });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
  });

  it("accepts github.com subdomains over https", async () => {
    const { tool } = build();
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://www.github.com/a/b",
    });
    expect(result.isError).toBeFalsy();
  });

  it("reports agent_not_found when the caller's agent row is gone", async () => {
    const { tool, calls } = build({ agent: undefined });
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(calls.taskCreate).toHaveLength(0);
    expect(calls.dispatch).toHaveLength(0);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run with the same session id", async () => {
    const { tool, calls } = build();
    const result = await tool.handler({
      goal: "  Extract tables from this PDF  ",
      repo_url: "  https://github.com/owner/repo  ",
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Record<string, string>;

    // Container task is pinned to the resolved agent on both sides.
    expect(calls.taskCreate[0]).toMatchObject({
      title: "Extract tables from this PDF",
      description: "Extract tables from this PDF",
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });

    // repo_run.session_id FKs to session.id, so the dispatch (which
    // creates the session row) must carry the pre-minted id.
    expect(calls.dispatch[0]).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: "Extract tables from this PDF",
      reason: { kind: "fresh" },
      sessionIdOverride: content.session_id,
    });
    expect(calls.repoRunCreate[0]).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_a",
      goal: "Extract tables from this PDF",
      repo_url: "https://github.com/owner/repo",
      status: "pending",
    });
  });

  it("returns the ids, pending status and the UI watch url", async () => {
    const { tool } = build();
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
    });
    const content = result.content as Record<string, unknown>;
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    expect(content.note).toContain("Sandbox run started");
    expect(typeof content.task_id).toBe("string");
  });

  it("collapses whitespace and ellipsizes the container task title at 80 chars", async () => {
    const { tool, calls } = build();
    const goal = "a".repeat(60) + "\n\n" + "b".repeat(60);
    await tool.handler({ goal, repo_url: "https://github.com/a/b" });

    const title = calls.taskCreate[0]?.title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // description keeps the full goal; only the title is cut.
    expect(calls.taskCreate[0]?.description).toBe(goal);
  });

  it("keeps a title of exactly 80 chars intact", async () => {
    const { tool, calls } = build();
    await tool.handler({ goal: "x".repeat(80), repo_url: "https://github.com/a/b" });
    expect(calls.taskCreate[0]?.title).toBe("x".repeat(80));
  });

  it("echoes trimmed input_url / input_filename back to the agent", async () => {
    const { tool } = build();
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
      input_url: "  https://example.test/in.pdf  ",
      input_filename: "  in.pdf  ",
    });
    expect(result.content).toMatchObject({
      input_url: "https://example.test/in.pdf",
      input_filename: "in.pdf",
    });
  });

  it("omits input fields that weren't strings", async () => {
    const { tool } = build();
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
      input_url: 1,
    });
    const content = result.content as Record<string, unknown>;
    expect(content.input_url).toBeUndefined();
    expect(content.input_filename).toBeUndefined();
  });
});

describe("use_repo limit clamping", () => {
  async function limitsFor(limits: unknown) {
    const { tool } = build();
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
      limits,
    });
    return (result.content as { limits: Record<string, number> }).limits;
  }

  it("defaults to an empty object when limits is absent or not an object", async () => {
    expect(await limitsFor(undefined)).toEqual({});
    expect(await limitsFor(null)).toEqual({});
    expect(await limitsFor("20")).toEqual({});
  });

  it("caps wall_clock_minutes at 60", async () => {
    expect(await limitsFor({ wall_clock_minutes: 5 })).toEqual({ wall_clock_minutes: 5 });
    expect(await limitsFor({ wall_clock_minutes: 900 })).toEqual({
      wall_clock_minutes: 60,
    });
  });

  it("floors and caps max_install_attempts at 5", async () => {
    expect(await limitsFor({ max_install_attempts: 3.9 })).toEqual({
      max_install_attempts: 3,
    });
    expect(await limitsFor({ max_install_attempts: 50 })).toEqual({
      max_install_attempts: 5,
    });
  });

  it("floors and caps disk_mb at 10000", async () => {
    expect(await limitsFor({ disk_mb: 512.7 })).toEqual({ disk_mb: 512 });
    expect(await limitsFor({ disk_mb: 999_999 })).toEqual({ disk_mb: 10_000 });
  });

  it("drops non-positive and non-numeric limits rather than passing them on", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      }),
    ).toEqual({});
  });
});

describe("use_repo failure envelopes", () => {
  it("reports dispatch_failed without inserting a repo_run", async () => {
    const { tool, calls } = build({ dispatchError: new Error("daemon offline") });
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(calls.repoRunCreate).toHaveLength(0);
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { tool } = build({ dispatchError: "boom" });
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
    });
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const { tool, calls } = build({ repoRunError: new Error("duplicate key") });
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The session was already dispatched — that's the orphan the error warns about.
    expect(calls.dispatch).toHaveLength(1);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { tool } = build({ repoRunError: "23505" });
    const result = await tool.handler({
      goal: "do a thing",
      repo_url: "https://github.com/a/b",
    });
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "23505",
    });
  });
});
