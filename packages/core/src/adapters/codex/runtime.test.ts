import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeContext, RuntimeStep } from "../../ports/runtime.js";
import { CodexRuntime } from "./runtime.js";
import { CODEX_EVENT_TYPE, CODEX_ITEM_TYPE } from "./stream-json.js";
import type { CliProcessOptions, CliProcessResult } from "../claude-code/spawn.js";
import * as spawnModule from "../claude-code/spawn.js";

/**
 * Canonical stdout for a clean codex turn — fixtures match the schema in
 * codex-rs/exec/src/exec_events.rs. The parser unit tests in
 * ./stream-json.test.ts cover edge cases; this file exercises the
 * end-to-end runtime wiring (args + env + last-message file + step
 * streaming) on top of those fixtures.
 */
const CANONICAL_STDOUT =
  JSON.stringify({ type: CODEX_EVENT_TYPE.ThreadStarted, thread_id: "thread_abc" }) +
  "\n" +
  JSON.stringify({
    type: CODEX_EVENT_TYPE.ItemCompleted,
    item: { id: "item_1", type: CODEX_ITEM_TYPE.AgentMessage, text: "done" },
  }) +
  "\n" +
  JSON.stringify({
    type: CODEX_EVENT_TYPE.TurnCompleted,
    usage: {
      input_tokens: 100,
      cached_input_tokens: 60,
      output_tokens: 40,
      reasoning_output_tokens: 10,
    },
  }) +
  "\n";

const MOCK_OK: CliProcessResult = {
  stdout: CANONICAL_STDOUT,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  aborted: false,
  pid: 9999,
  process_group_id: 9999,
  truncated: false,
};

let runCliSpy: ReturnType<typeof vi.spyOn>;
let lastOptions: CliProcessOptions | undefined;

function mockRunCli(result: CliProcessResult = MOCK_OK): void {
  runCliSpy.mockImplementation(async (options) => {
    lastOptions = options;
    if (result.pid !== null) {
      options.onSpawn?.({ pid: result.pid, process_group_id: result.process_group_id ?? result.pid });
    }
    if (result.stdout) options.onLog?.("stdout", result.stdout);
    const outputIdx = options.args?.indexOf("--output-last-message") ?? -1;
    const outputPath = outputIdx >= 0 ? options.args?.[outputIdx + 1] : undefined;
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, "last message from file", "utf8");
    }
    return result;
  });
}

function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "do a thing",
    workspace: { path: `/tmp/beevibe-codex-test-${Math.random()}` },
    system_prompt_append: "",
    ...overrides,
  };
}

beforeEach(() => {
  lastOptions = undefined;
  runCliSpy = vi.spyOn(spawnModule, "runCliProcess");
});

afterEach(() => {
  runCliSpy.mockRestore();
});

describe("CodexRuntime.execute", () => {
  it("runs codex exec non-interactively with JSON events", async () => {
    mockRunCli();
    await new CodexRuntime().execute(ctx({ workspace: { path: "/tmp/agent_codex" } }));
    expect(lastOptions?.cwd).toBe("/tmp/agent_codex");
    expect(lastOptions?.args?.slice(0, 8)).toEqual([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--cd",
      "/tmp/agent_codex",
      "exec",
      "--json",
    ]);
  });

  it("passes context.model as --model", async () => {
    mockRunCli();
    await new CodexRuntime({ model: "fallback" }).execute(ctx({ model: "gpt-5.5" }));
    const idx = lastOptions!.args!.indexOf("--model");
    expect(lastOptions!.args![idx + 1]).toBe("gpt-5.5");
  });

  it("uses exec resume when context.resume_session_id is set", async () => {
    mockRunCli();
    await new CodexRuntime().execute(ctx({ resume_session_id: "codex_prev" }));
    const execIdx = lastOptions!.args!.indexOf("exec");
    expect(lastOptions!.args!.slice(execIdx, execIdx + 3)).toEqual([
      "exec",
      "resume",
      "--json",
    ]);
    expect(lastOptions!.args).toContain("codex_prev");
  });

  it("folds system_prompt_append into the prompt", async () => {
    mockRunCli();
    await new CodexRuntime().execute(
      ctx({ intent: "fix bug", system_prompt_append: "<core>memory</core>" }),
    );
    const prompt = lastOptions!.args!.at(-1)!;
    expect(prompt).toContain("<beevibe_system_context>");
    expect(prompt).toContain("<core>memory</core>");
    expect(prompt).toContain("fix bug");
  });

  it("adds Beevibe MCP config overrides after workspace preparation", async () => {
    mockRunCli();
    const runtime = new CodexRuntime();
    runtime.prepareWorkspace({
      workspace: { path: "/tmp/beevibe-codex-test-mcp" },
      agentApiKey: "bv_a_test",
      mcpServerUrl: "http://api.test/mcp",
    });
    await runtime.execute(
      ctx({
        workspace: { path: "/tmp/beevibe-codex-test-mcp" },
        env: { BEEVIBE_SESSION_ID: "sess_test_123" },
      }),
    );
    expect(lastOptions!.env!.BEEVIBE_AGENT_API_KEY).toBe("bv_a_test");
    expect(lastOptions!.args).toContain(
      'mcp_servers.beevibe.url="http://api.test/mcp?beevibe_session=sess_test_123"',
    );
    expect(lastOptions!.args).toContain(
      'mcp_servers.beevibe.bearer_token_env_var="BEEVIBE_AGENT_API_KEY"',
    );
    // Regression: codex's --ask-for-approval never doesn't extend to MCP
    // tool calls; without this override every tool call fails with
    // "user cancelled MCP tool call" in headless exec mode.
    expect(lastOptions!.args).toContain(
      'mcp_servers.beevibe.default_tools_approval_mode="approve"',
    );
  });

  it("strips OPENAI_API_KEY / OPENAI_AUTH_TOKEN from the spawned env to preserve subscription auth", async () => {
    mockRunCli();
    const prior = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_AUTH_TOKEN: process.env.OPENAI_AUTH_TOKEN,
    };
    process.env.OPENAI_API_KEY = "sk-leaked";
    process.env.OPENAI_AUTH_TOKEN = "token-leaked";
    try {
      await new CodexRuntime().execute(ctx());
    } finally {
      if (prior.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior.OPENAI_API_KEY;
      if (prior.OPENAI_AUTH_TOKEN === undefined) delete process.env.OPENAI_AUTH_TOKEN;
      else process.env.OPENAI_AUTH_TOKEN = prior.OPENAI_AUTH_TOKEN;
    }
    expect(lastOptions!.env!.OPENAI_API_KEY).toBeUndefined();
    expect(lastOptions!.env!.OPENAI_AUTH_TOKEN).toBeUndefined();
  });

  it("warns when stdout was truncated at the spawn cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunCli({ ...MOCK_OK, truncated: true });
    await new CodexRuntime().execute(ctx());
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("stdout truncated at 4MB"),
    );
    warnSpy.mockRestore();
  });

  it("parses canonical event stream into RuntimeResult and prefers output-last-message", async () => {
    mockRunCli();
    const result = await new CodexRuntime().execute(ctx());
    expect(result.status).toBe("completed");
    expect(result.output).toBe("last message from file");
    expect(result.cli_session_id).toBe("thread_abc");
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 60,
    });
  });

  it("streams tool steps from mcp_tool_call items (started → tool_call, completed → tool_result)", async () => {
    const steps: RuntimeStep[] = [];
    runCliSpy.mockImplementation(async (options) => {
      const stdout =
        JSON.stringify({
          type: CODEX_EVENT_TYPE.ItemStarted,
          item: {
            id: "item_t",
            type: CODEX_ITEM_TYPE.McpToolCall,
            server: "beevibe",
            tool: "create_task",
            arguments: { title: "fix" },
            status: "in_progress",
          },
        }) +
        "\n" +
        JSON.stringify({
          type: CODEX_EVENT_TYPE.ItemCompleted,
          item: {
            id: "item_t",
            type: CODEX_ITEM_TYPE.McpToolCall,
            server: "beevibe",
            tool: "create_task",
            arguments: { title: "fix" },
            result: { content: [{ type: "text", text: "ok" }] },
            status: "completed",
          },
        }) +
        "\n";
      options.onLog?.("stdout", stdout);
      return { ...MOCK_OK, stdout };
    });
    await new CodexRuntime().execute(ctx({ onStep: (s) => steps.push(s) }));
    expect(steps).toEqual([
      expect.objectContaining({ kind: "tool_call", tool: "create_task" }),
      expect.objectContaining({ kind: "tool_result", tool: "create_task" }),
    ]);
  });

  it("maps aborted result to cancelled", async () => {
    mockRunCli({ ...MOCK_OK, aborted: true, stdout: "" });
    const result = await new CodexRuntime().execute(ctx());
    expect(result.status).toBe("cancelled");
  });

  it("surfaces stderr tail on failure so /runtime/done has something actionable", async () => {
    runCliSpy.mockImplementation(async (options) => {
      lastOptions = options;
      return {
        ...MOCK_OK,
        stdout: "",
        stderr: "Error: rate limited\n",
        exitCode: 1,
      };
    });
    const result = await new CodexRuntime().execute(ctx());
    expect(result.status).toBe("failed");
    expect(result.stderr).toBe("Error: rate limited\n");
  });

  it("prefers structured Codex errors over noisy stderr", async () => {
    runCliSpy.mockImplementation(async (options) => {
      lastOptions = options;
      const stdout =
        JSON.stringify({ type: CODEX_EVENT_TYPE.Error, message: "You've hit your usage limit." }) +
        "\n";
      options.onLog?.("stdout", stdout);
      return {
        ...MOCK_OK,
        stdout,
        stderr: "WARN plugin noise",
        exitCode: 1,
      };
    });
    const result = await new CodexRuntime().execute(ctx());
    expect(result.status).toBe("failed");
    expect(result.output).toBe("You've hit your usage limit.");
  });
});

describe("CodexRuntime.healthCheck", () => {
  it("runs codex --version", async () => {
    mockRunCli({ ...MOCK_OK, stdout: "", exitCode: 0 });
    const health = await new CodexRuntime().healthCheck();
    expect(health.healthy).toBe(true);
    expect(lastOptions!.args).toEqual(["--version"]);
    expect(lastOptions!.timeoutMs).toBe(5000);
    expect(lastOptions!.graceMs).toBe(0);
  });
});
