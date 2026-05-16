import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeContext, RuntimeStep } from "../../ports/runtime.js";
import { CodexRuntime } from "./runtime.js";
import type { CliProcessOptions, CliProcessResult } from "../claude-code/spawn.js";
import * as spawnModule from "../claude-code/spawn.js";

const MOCK_OK: CliProcessResult = {
  stdout:
    JSON.stringify({
      type: "thread.started",
      thread_id: "codex_thread_mock",
    }) +
    "\n" +
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
      usage: { input_tokens: 100, output_tokens: 50, model: "gpt-5.5" },
    }) +
    "\n",
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
    workspace: { path: "/tmp/beevibe-codex-test-ws" },
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
      workspace: { path: "/tmp/beevibe-codex-test-ws" },
      agentApiKey: "bv_a_test",
      mcpServerUrl: "http://api.test/mcp",
    });
    await runtime.execute(ctx({ env: { BEEVIBE_SESSION_ID: "sess_test_123" } }));
    expect(lastOptions!.env!.BEEVIBE_AGENT_API_KEY).toBe("bv_a_test");
    expect(lastOptions!.args).toContain(
      'mcp_servers.beevibe.url="http://api.test/mcp?beevibe_session=sess_test_123"',
    );
    expect(lastOptions!.args).toContain(
      'mcp_servers.beevibe.bearer_token_env_var="BEEVIBE_AGENT_API_KEY"',
    );
  });

  it("parses result events into RuntimeResult and prefers output-last-message", async () => {
    mockRunCli();
    const result = await new CodexRuntime().execute(ctx());
    expect(result.status).toBe("completed");
    expect(result.output).toBe("last message from file");
    expect(result.cli_session_id).toBe("codex_thread_mock");
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      model: "gpt-5.5",
    });
  });

  it("emits tool steps from JSON event shapes", async () => {
    const steps: RuntimeStep[] = [];
    runCliSpy.mockImplementation(async (options) => {
      options.onLog?.(
        "stdout",
        JSON.stringify({
          type: "tool_call",
          tool: "shell",
          input: { command: "ls" },
        }) + "\n",
      );
      return MOCK_OK;
    });
    await new CodexRuntime().execute(ctx({ onStep: (step) => steps.push(step) }));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("tool_call");
    expect(steps[0]!.tool).toBe("shell");
    expect(steps[0]!.description).toBe("ls");
  });

  it("maps aborted result to cancelled", async () => {
    mockRunCli({ ...MOCK_OK, aborted: true, stdout: "" });
    const result = await new CodexRuntime().execute(ctx());
    expect(result.status).toBe("cancelled");
  });

  it("drops non-JSON log noise from stdout when no assistant text was extracted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    runCliSpy.mockImplementation(async (options) => {
      lastOptions = options;
      // Codex's Rust binary prints `tracing` WARN lines to stdout
      // alongside JSON events. With no assistant message in events
      // and no last-message file, the old fallback dumped these
      // warnings as the chat reply.
      const stdout =
        "2026-05-16T16:50:34Z WARN codex_core_skills::loader: ignoring interface.icon_small: icon path must not contain '..'\n" +
        JSON.stringify({ type: "thread.started", thread_id: "codex_t1" }) +
        "\n";
      options.onLog?.("stdout", stdout);
      return { ...MOCK_OK, stdout, exitCode: 0 };
    });
    // Unique workspace so a sibling test's last-message file (which
    // shares a directory and a millisecond-precision filename) can't
    // bleed in.
    const result = await new CodexRuntime().execute(
      ctx({ workspace: { path: `/tmp/beevibe-codex-noise-${Math.random()}` } }),
    );
    expect(result.output).toBe("Codex completed.");
    expect(result.output).not.toContain("WARN");
    warnSpy.mockRestore();
  });

  it("extracts text from nested delta objects", async () => {
    runCliSpy.mockImplementation(async (options) => {
      lastOptions = options;
      const stdout =
        JSON.stringify({ type: "item.delta", delta: { text: "hello world" } }) + "\n";
      options.onLog?.("stdout", stdout);
      return { ...MOCK_OK, stdout, exitCode: 0 };
    });
    const result = await new CodexRuntime().execute(
      ctx({ workspace: { path: `/tmp/beevibe-codex-delta-${Math.random()}` } }),
    );
    expect(result.output).toBe("hello world");
  });

  it("prefers structured Codex errors over noisy stderr", async () => {
    runCliSpy.mockImplementation(async (options) => {
      lastOptions = options;
      const stdout =
        JSON.stringify({ type: "error", message: "You've hit your usage limit." }) +
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
    expect(result.stderr).toBeUndefined();
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
