import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext, RuntimeStep } from "../../ports/runtime.js";
import { ClaudeCodeRuntime } from "./runtime.js";
import type { CliProcessOptions, CliProcessResult } from "./spawn.js";
import * as spawnModule from "./spawn.js";

const MOCK_OK: CliProcessResult = {
  stdout:
    JSON.stringify({
      type: "result",
      session_id: "cli_sess_mock",
      total_cost_usd: 0.01,
      model: "claude-opus-4-7",
      usage: { input_tokens: 100, output_tokens: 50 },
    }) + "\n",
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
    // The runtime parses incrementally via onLog now — replay stdout
    // through onLog so mocks don't have to do it themselves.
    if (result.stdout) options.onLog?.("stdout", result.stdout);
    return result;
  });
}

function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "do a thing",
    workspace: { path: "/tmp/beevibe-test-ws" },
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

describe("ClaudeCodeRuntime.execute", () => {
  it("sets cwd to workspace.path and derives mcpConfigPath inside it", async () => {
    mockRunCli();
    const runtime = new ClaudeCodeRuntime();
    await runtime.execute(ctx({ workspace: { path: "/sandbox/agent_xyz" } }));

    expect(lastOptions?.cwd).toBe("/sandbox/agent_xyz");
    const mcpIdx = lastOptions!.args!.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(lastOptions!.args![mcpIdx + 1]).toBe("/sandbox/agent_xyz/mcp-config.json");
  });

  it("includes --print -, stream-json, verbose, dangerously-skip-permissions, strict-mcp-config", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime().execute(ctx());
    const args = lastOptions!.args!.join(" ");
    expect(args).toContain("--print -");
    expect(args).toContain("--output-format stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--strict-mcp-config");
  });

  it("passes --model and --max-turns when configured", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime({ model: "claude-opus-4-7", maxTurns: 5 }).execute(ctx());
    expect(lastOptions!.args).toContain("--model");
    expect(lastOptions!.args).toContain("claude-opus-4-7");
    expect(lastOptions!.args).toContain("--max-turns");
    expect(lastOptions!.args).toContain("5");
  });

  it("omits --model and --max-turns when not configured", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime().execute(ctx());
    expect(lastOptions!.args).not.toContain("--model");
    expect(lastOptions!.args).not.toContain("--max-turns");
  });

  it("passes context.model + context.max_turns (per-agent override wins over constructor)", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime({ model: "ctor-default", maxTurns: 99 }).execute(
      ctx({ model: "claude-haiku-4-5", max_turns: 7 }),
    );
    // Context wins.
    const modelIdx = lastOptions!.args!.indexOf("--model");
    expect(lastOptions!.args![modelIdx + 1]).toBe("claude-haiku-4-5");
    const turnsIdx = lastOptions!.args!.indexOf("--max-turns");
    expect(lastOptions!.args![turnsIdx + 1]).toBe("7");
  });

  it("falls back to constructor config when context.model / context.max_turns are unset", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime({ model: "fallback", maxTurns: 3 }).execute(ctx());
    const modelIdx = lastOptions!.args!.indexOf("--model");
    expect(lastOptions!.args![modelIdx + 1]).toBe("fallback");
    const turnsIdx = lastOptions!.args!.indexOf("--max-turns");
    expect(lastOptions!.args![turnsIdx + 1]).toBe("3");
  });

  it("passes --resume when context.resume_session_id is set", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime().execute(ctx({ resume_session_id: "cli_prev_123" }));
    expect(lastOptions!.args).toContain("--resume");
    expect(lastOptions!.args).toContain("cli_prev_123");
  });

  it("forwards context.system_prompt_append as --append-system-prompt arg", async () => {
    mockRunCli();
    const briefing = "<core_memory><block name=\"persona\">Senior infra engineer.</block></core_memory>";
    await new ClaudeCodeRuntime().execute(ctx({ system_prompt_append: briefing }));
    const idx = lastOptions!.args!.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(lastOptions!.args![idx + 1]).toBe(briefing);
  });

  it("omits --append-system-prompt when system_prompt_append is empty", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime().execute(ctx({ system_prompt_append: "" }));
    expect(lastOptions!.args).not.toContain("--append-system-prompt");
  });

  it("merges context.env into the spawned process env (session id reaches MCP subprocesses)", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime().execute(
      ctx({ env: { BEEVIBE_SESSION_ID: "sess_test_123", CUSTOM_KEY: "xyz" } }),
    );
    expect(lastOptions!.env!.BEEVIBE_SESSION_ID).toBe("sess_test_123");
    expect(lastOptions!.env!.CUSTOM_KEY).toBe("xyz");
    // Baseline env is still present (e.g. PATH from process.env) and nesting
    // guards are still stripped.
    expect(lastOptions!.env!.CLAUDECODE).toBeUndefined();
  });

  it("context.env overrides process.env keys with the same name", async () => {
    mockRunCli();
    const original = { ...process.env };
    process.env.BEEVIBE_SESSION_ID = "from_process_env";
    try {
      await new ClaudeCodeRuntime().execute(
        ctx({ env: { BEEVIBE_SESSION_ID: "from_context" } }),
      );
      expect(lastOptions!.env!.BEEVIBE_SESSION_ID).toBe("from_context");
    } finally {
      process.env = original;
    }
  });

  it("strips Claude nesting-guard env vars", async () => {
    mockRunCli();
    const original = { ...process.env };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CLAUDE_CODE_SESSION = "sess";
    try {
      await new ClaudeCodeRuntime().execute(ctx());
      expect(lastOptions!.env!.CLAUDECODE).toBeUndefined();
      expect(lastOptions!.env!.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(lastOptions!.env!.CLAUDE_CODE_SESSION).toBeUndefined();
    } finally {
      process.env = original;
    }
  });

  it("forwards context.intent to spawn as stdin", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime().execute(ctx({ intent: "fix bug X" }));
    expect(lastOptions!.stdin).toBe("fix bug X");
  });

  it("wires onSpawn with renamed process_pid/process_group_id fields", async () => {
    mockRunCli({
      ...MOCK_OK,
      pid: 12345,
      process_group_id: 12345,
    });
    const spawnEvents: Array<{ process_pid: number; process_group_id: number }> = [];
    await new ClaudeCodeRuntime().execute(
      ctx({ onSpawn: (meta) => spawnEvents.push(meta) }),
    );
    expect(spawnEvents).toEqual([{ process_pid: 12345, process_group_id: 12345 }]);
  });

  it("wires onStep by running stdout chunks through stream-json parser", async () => {
    const steps: RuntimeStep[] = [];
    runCliSpy.mockImplementation(async (options) => {
      options.onLog?.(
        "stdout",
        JSON.stringify({
          type: "tool_use",
          name: "Read",
          input: { file_path: "/src/x.ts" },
        }) + "\n",
      );
      return MOCK_OK;
    });
    await new ClaudeCodeRuntime().execute(
      ctx({ onStep: (step) => steps.push(step) }),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.tool).toBe("Read");
    expect(steps[0]!.description).toBe("/src/x.ts");
  });

  it("line buffer handles JSON messages split across chunks", async () => {
    // A single message delivered in two pieces, neither containing a
    // complete line on its own. Without buffering, both halves would
    // fail to parse and the cli_session_id would be lost.
    const fullLine =
      JSON.stringify({
        type: "result",
        session_id: "cli_sess_split",
        total_cost_usd: 0.001,
        model: "claude-opus-4-7",
        usage: { input_tokens: 10, output_tokens: 5 },
      }) + "\n";
    const split = Math.floor(fullLine.length / 2);

    runCliSpy.mockImplementation(async (options) => {
      options.onLog?.("stdout", fullLine.slice(0, split));
      options.onLog?.("stdout", fullLine.slice(split));
      // Empty result.stdout to prove we're NOT falling back to a post-hoc
      // parse of the full buffer — parsing must happen via the live messages.
      return { ...MOCK_OK, stdout: "" };
    });

    const result = await new ClaudeCodeRuntime().execute(ctx());
    expect(result.status).toBe("completed");
    expect(result.cli_session_id).toBe("cli_sess_split");
    expect(result.usage?.input_tokens).toBe(10);
  });

  it("line buffer flushes trailing partial line without newline at end", async () => {
    // No trailing \n. A naive implementation that only emits on \n would
    // drop this final line.
    const msg = JSON.stringify({
      type: "result",
      session_id: "cli_sess_noNL",
      total_cost_usd: 0,
      model: "x",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    runCliSpy.mockImplementation(async (options) => {
      options.onLog?.("stdout", msg);
      return { ...MOCK_OK, stdout: "" };
    });

    const result = await new ClaudeCodeRuntime().execute(ctx());
    expect(result.cli_session_id).toBe("cli_sess_noNL");
  });

  it("onStep fires exactly once per tool_use even when chunked mid-line", async () => {
    const steps: RuntimeStep[] = [];
    const fullLine =
      JSON.stringify({
        type: "tool_use",
        name: "Bash",
        input: { command: "ls" },
      }) + "\n";
    const split = Math.floor(fullLine.length / 2);

    runCliSpy.mockImplementation(async (options) => {
      options.onLog?.("stdout", fullLine.slice(0, split));
      options.onLog?.("stdout", fullLine.slice(split));
      return MOCK_OK;
    });

    await new ClaudeCodeRuntime().execute(
      ctx({ onStep: (step) => steps.push(step) }),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.tool).toBe("Bash");
  });

  it("maps aborted result → status: 'cancelled' (distinct from failed)", async () => {
    mockRunCli({ ...MOCK_OK, exitCode: null, aborted: true, stdout: "" });
    const result = await new ClaudeCodeRuntime().execute(ctx());
    expect(result.status).toBe("cancelled");
    expect(result.output).toBe("Session cancelled.");
  });

  it("maps exit 0 → status: 'completed'", async () => {
    mockRunCli();
    const result = await new ClaudeCodeRuntime().execute(ctx());
    expect(result.status).toBe("completed");
    expect(result.cli_session_id).toBe("cli_sess_mock");
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd: 0.01,
      model: "claude-opus-4-7",
    });
  });

  it("maps non-zero exit → status: 'failed'", async () => {
    mockRunCli({ ...MOCK_OK, exitCode: 1, stdout: "" });
    const result = await new ClaudeCodeRuntime().execute(ctx());
    expect(result.status).toBe("failed");
  });

  it("logs a warning when stdout is truncated", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockRunCli({ ...MOCK_OK, truncated: true });
    await new ClaudeCodeRuntime().execute(ctx());
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("truncated at 4MB"),
    );
    warnSpy.mockRestore();
  });

  it("surfaces process_pid + process_group_id on the result", async () => {
    mockRunCli({ ...MOCK_OK, pid: 7777, process_group_id: 7777 });
    const result = await new ClaudeCodeRuntime().execute(ctx());
    expect(result.process_pid).toBe(7777);
    expect(result.process_group_id).toBe(7777);
  });
});

describe("ClaudeCodeRuntime.healthCheck", () => {
  it("returns healthy when CLI exits 0", async () => {
    mockRunCli({ ...MOCK_OK, stdout: "", exitCode: 0 });
    const runtime = new ClaudeCodeRuntime();
    const health = await runtime.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it("returns unhealthy on non-zero exit", async () => {
    mockRunCli({ ...MOCK_OK, stdout: "", exitCode: 1 });
    const health = await new ClaudeCodeRuntime().healthCheck();
    expect(health.healthy).toBe(false);
  });

  it("uses graceMs: 0 so a broken CLI fails fast", async () => {
    mockRunCli();
    await new ClaudeCodeRuntime().healthCheck();
    expect(lastOptions!.graceMs).toBe(0);
    expect(lastOptions!.timeoutMs).toBe(5000);
  });

  it("returns unhealthy with error message when spawn throws", async () => {
    runCliSpy.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const health = await new ClaudeCodeRuntime({ command: "not-claude" }).healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.error).toContain("not-claude");
  });
});
