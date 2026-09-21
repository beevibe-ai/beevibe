import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, RuntimeContext, RuntimeResult, RuntimeRegistry, Workspace } from "@beevibe/core";
import { runDispatch, type DispatchPayload } from "./spawner.js";

const { runRepoDispatchMock } = vi.hoisted(() => ({ runRepoDispatchMock: vi.fn() }));

vi.mock("./repo-runs.js", () => ({ runRepoDispatch: runRepoDispatchMock }));
vi.mock("./logger.js", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

function payload(overrides: Partial<DispatchPayload> = {}): DispatchPayload {
  return {
    session_id: "sess_123",
    agent_id: "agent_123",
    agent_api_key: "bv_a_test",
    agent_hierarchy_level: "team",
    runtime_type: "opencode",
    intent: "do work",
    system_prompt_append: "<core />",
    model: "openrouter/qwen/qwen3-coder",
    max_turns: 3,
    env: { BEEVIBE_SESSION_ID: "sess_123", BEEVIBE_AGENT_ID: "agent_123" },
    type: "task",
    mcp_server_url: "http://api.test/mcp",
    ...overrides,
  };
}

describe("runDispatch", () => {
  it("uses payload.runtime_type for workspace provisioning and runtime execution", async () => {
    let ensuredAgentRuntimeType: string | undefined;
    let runtimeContext: RuntimeContext | undefined;
    const runtime: AgentRuntime = {
      type: "opencode",
      execute: vi.fn(async (ctx: RuntimeContext): Promise<RuntimeResult> => {
        runtimeContext = ctx;
        ctx.onStep?.({
          kind: "tool_call",
          tool: "read",
          description: "README.md",
          timestamp: new Date().toISOString(),
        });
        return {
          status: "completed",
          output: "done",
          cli_session_id: "opencode_sess_1",
          usage: { input_tokens: 1, output_tokens: 2 },
        };
      }),
      healthCheck: vi.fn(),
      skillsDir: (workspace: Workspace) => `${workspace.path}/.opencode/skills`,
    };
    const posts: Array<{ path: string; body: unknown }> = [];
    const api = {
      post: vi.fn(async (path: string, body: unknown) => {
        posts.push({ path, body });
      }),
    };
    const workspaceManager = {
      ensureWorkspace: vi.fn(async ({ agent }) => {
        ensuredAgentRuntimeType = agent.runtime_config.type;
        return { path: "/tmp/ws-opencode" };
      }),
    };

    await runDispatch(
      {
        api: api as never,
        workspaceManager: workspaceManager as never,
        runtimeRegistry: { opencode: runtime } as RuntimeRegistry,
      },
      payload(),
    );

    expect(ensuredAgentRuntimeType).toBe("opencode");
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(runtimeContext?.model).toBe("openrouter/qwen/qwen3-coder");
    expect(posts.some((p) => p.path === "/runtime/events")).toBe(true);
    const done = posts.find((p) => p.path === "/runtime/done")!.body as {
      status: string;
      cli_session_id: string;
    };
    expect(done.status).toBe("succeeded");
    expect(done.cli_session_id).toBe("opencode_sess_1");
  });
});

interface Post {
  path: string;
  body: Record<string, unknown>;
}

/** A runtime that resolves with `result`, or throws `result` if it is an Error. */
function fakeRuntime(result: Partial<RuntimeResult> | Error): AgentRuntime {
  return {
    type: "opencode",
    execute: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result as RuntimeResult;
    }),
    healthCheck: vi.fn(),
    skillsDir: (workspace: Workspace) => `${workspace.path}/.opencode/skills`,
  };
}

function harness(
  runtime?: AgentRuntime,
  postImpl?: (path: string) => Promise<unknown>,
): { deps: Parameters<typeof runDispatch>[0]; posts: Post[] } {
  const posts: Post[] = [];
  const api = {
    post: vi.fn(async (path: string, body: unknown) => {
      posts.push({ path, body: body as Record<string, unknown> });
      return postImpl ? await postImpl(path) : undefined;
    }),
  };
  const workspaceManager = {
    ensureWorkspace: vi.fn(async () => ({ path: "/tmp/ws-opencode" })),
  };
  return {
    deps: {
      api: api as never,
      workspaceManager: workspaceManager as never,
      runtimeRegistry: (runtime ? { opencode: runtime } : {}) as RuntimeRegistry,
    },
    posts,
  };
}

function doneOf(posts: Post[]): Record<string, unknown> {
  const done = posts.find((p) => p.path === "/runtime/done");
  if (!done) throw new Error("no /runtime/done POST was made");
  return done.body;
}

describe("runDispatch terminal reporting", () => {
  it("hands a run_repo dispatch to the sandbox orchestrator without provisioning a workspace", async () => {
    runRepoDispatchMock.mockReset();
    const runtime = fakeRuntime({ status: "completed" });
    const { deps } = harness(runtime);
    const signal = new AbortController().signal;
    const p = payload({ type: "run_repo" });

    await runDispatch(deps, p, signal);

    expect(runRepoDispatchMock).toHaveBeenCalledWith(
      { api: expect.anything() },
      p,
      signal,
    );
    expect(deps.workspaceManager.ensureWorkspace).not.toHaveBeenCalled();
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("throws a named error when the payload asks for a runtime the daemon has no adapter for", async () => {
    const { deps, posts } = harness();

    await expect(runDispatch(deps, payload())).rejects.toThrow(/opencode/);
    expect(posts).toEqual([]);
  });

  it.each([
    { status: "completed", expected: "succeeded" },
    { status: "cancelled", expected: "cancelled" },
    { status: "failed", expected: "failed" },
    { status: "timed_out", expected: "failed" },
  ] as const)(
    "reports runtime status '$status' as session status '$expected'",
    async ({ status, expected }) => {
      const { deps, posts } = harness(
        fakeRuntime({ status: status as RuntimeResult["status"], output: "" }),
      );

      await runDispatch(deps, payload());

      expect(doneOf(posts).status).toBe(expected);
    },
  );

  it("reports a spawn-time throw as failed with a null exit code, so the api can tell it never ran", async () => {
    const { deps, posts } = harness(
      fakeRuntime(new Error("spawn claude ENOENT")),
    );

    await runDispatch(deps, payload());

    expect(doneOf(posts)).toMatchObject({
      status: "failed",
      exit_code: null,
      error: "spawn claude ENOENT",
      result_summary: "",
    });
  });

  it("wraps a non-Error throw so the failure still carries a message", async () => {
    const runtime = fakeRuntime({ status: "completed" });
    runtime.execute = vi.fn(async () => {
      throw "just a string";
    });
    const { deps, posts } = harness(runtime);

    await runDispatch(deps, payload());

    expect(doneOf(posts)).toMatchObject({ status: "failed", error: "just a string" });
  });

  it("prefers the CLI's stderr tail as the error when the runtime ran but failed", async () => {
    const { deps, posts } = harness(
      fakeRuntime({
        status: "failed",
        output: "",
        exit_code: 1,
        stderr: "Error: model not found",
      }),
    );

    await runDispatch(deps, payload());

    expect(doneOf(posts)).toMatchObject({
      status: "failed",
      exit_code: 1,
      error: "Error: model not found",
    });
  });

  it("forwards usage and cli_session_id from a successful run", async () => {
    const { deps, posts } = harness(
      fakeRuntime({
        status: "completed",
        output: "all done",
        exit_code: 0,
        cli_session_id: "opencode_sess_9",
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    );

    await runDispatch(deps, payload());

    expect(doneOf(posts)).toMatchObject({
      session_id: "sess_123",
      status: "succeeded",
      exit_code: 0,
      cli_session_id: "opencode_sess_9",
      result_summary: "all done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });

  it("flushes buffered events before reporting done", async () => {
    const runtime = fakeRuntime({ status: "completed", output: "" });
    runtime.execute = vi.fn(async (ctx: RuntimeContext) => {
      ctx.onStep?.({
        kind: "tool_call",
        tool: "read",
        description: "README.md",
        timestamp: new Date().toISOString(),
      });
      return { status: "completed", output: "" } as RuntimeResult;
    });
    const { deps, posts } = harness(runtime);

    await runDispatch(deps, payload());

    expect(posts.map((p) => p.path)).toEqual(["/runtime/events", "/runtime/done"]);
    expect(posts[0]?.body.events).toEqual([
      {
        session_id: "sess_123",
        kind: "tool_call",
        content: "README.md",
        tool_name: "read",
      },
    ]);
  });

  it("does not throw when the /runtime/done POST fails — the session is already over", async () => {
    const { deps } = harness(
      fakeRuntime({ status: "completed", output: "" }),
      async (path) => {
        if (path === "/runtime/done") throw new Error("connection reset");
        return undefined;
      },
    );

    await expect(runDispatch(deps, payload())).resolves.toBeUndefined();
  });
});
