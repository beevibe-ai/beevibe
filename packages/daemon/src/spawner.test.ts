import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, RuntimeContext, RuntimeResult, RuntimeRegistry, Workspace } from "@beevibe/core";
import { runDispatch, type DispatchPayload } from "./spawner.js";

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
      shutdown: vi.fn(),
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
