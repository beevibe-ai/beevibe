import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext, RuntimeStep } from "../../ports/runtime.js";
import { OpenCodeRuntime, buildOpenCodeConfig } from "./runtime.js";
import { OPENCODE_EVENT_TYPE } from "./stream-json.js";
import type { CliProcessOptions, CliProcessResult } from "../claude-code/spawn.js";
import * as spawnModule from "../claude-code/spawn.js";

const SID = "ses_op_mock";

/**
 * Canonical stdout for a clean opencode turn. Wrapper shape matches
 * opencode's run.ts `emit()` helper: every event carries top-level
 * `sessionID`. The parser unit tests in ./stream-json.test.ts cover
 * edge cases; this file exercises the runtime wiring on top of them.
 */
const CANONICAL_STDOUT =
  JSON.stringify({
    type: OPENCODE_EVENT_TYPE.Text,
    timestamp: 1,
    sessionID: SID,
    part: {
      id: "prt_t",
      sessionID: SID,
      messageID: "msg_1",
      type: "text",
      text: "done",
      time: { start: 0, end: 1 },
    },
  }) +
  "\n" +
  JSON.stringify({
    type: OPENCODE_EVENT_TYPE.StepFinish,
    timestamp: 2,
    sessionID: SID,
    part: {
      id: "prt_s",
      sessionID: SID,
      messageID: "msg_1",
      type: "step-finish",
      cost: 0,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
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
    return result;
  });
}

function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "do a thing",
    workspace: { path: "/tmp/beevibe-opencode-test-ws" },
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

describe("OpenCodeRuntime.execute", () => {
  it("runs opencode non-interactively with the canonical JSON format flags", async () => {
    mockRunCli();
    await new OpenCodeRuntime().execute(ctx({ workspace: { path: "/sandbox/agent_op" } }));
    expect(lastOptions?.cwd).toBe("/sandbox/agent_op");
    expect(lastOptions?.args?.slice(0, 6)).toEqual([
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
      "--dir",
      "/sandbox/agent_op",
    ]);
  });

  it("passes --dir to opencode so workspace opencode.json is actually loaded", async () => {
    // Regression: without --dir, opencode run ignores the workspace
    // opencode.json (the subprocess cwd alone doesn't drive config
    // discovery), so the agent never sees the beevibe MCP server.
    mockRunCli();
    await new OpenCodeRuntime().execute(ctx({ workspace: { path: "/agents/foo" } }));
    const dirIdx = lastOptions!.args!.indexOf("--dir");
    expect(dirIdx).toBeGreaterThan(-1);
    expect(lastOptions!.args![dirIdx + 1]).toBe("/agents/foo");
  });

  it("passes context.model as --model in provider/model form", async () => {
    mockRunCli();
    await new OpenCodeRuntime({ model: "fallback/model" }).execute(
      ctx({ model: "openrouter/qwen/qwen3-coder" }),
    );
    const idx = lastOptions!.args!.indexOf("--model");
    expect(lastOptions!.args![idx + 1]).toBe("openrouter/qwen/qwen3-coder");
  });

  it("passes --session when context.resume_session_id is set", async () => {
    mockRunCli();
    await new OpenCodeRuntime().execute(ctx({ resume_session_id: "opencode_prev" }));
    const idx = lastOptions!.args!.indexOf("--session");
    expect(lastOptions!.args![idx + 1]).toBe("opencode_prev");
  });

  it("folds system_prompt_append into the prompt because OpenCode has no append-system flag", async () => {
    mockRunCli();
    await new OpenCodeRuntime().execute(
      ctx({ intent: "fix bug", system_prompt_append: "<core>memory</core>" }),
    );
    const prompt = lastOptions!.args!.at(-1)!;
    expect(prompt).toContain("<beevibe_system_context>");
    expect(prompt).toContain("<core>memory</core>");
    expect(prompt).toContain("fix bug");
  });

  it("merges context.env into the spawned process env", async () => {
    mockRunCli();
    await new OpenCodeRuntime().execute(
      ctx({ env: { BEEVIBE_SESSION_ID: "sess_test_123" } }),
    );
    expect(lastOptions!.env!.BEEVIBE_SESSION_ID).toBe("sess_test_123");
  });

  it("parses canonical wrapper events into a RuntimeResult", async () => {
    mockRunCli();
    const result = await new OpenCodeRuntime().execute(ctx());
    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");
    expect(result.cli_session_id).toBe(SID);
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd: 0,
    });
  });

  it("streams a tool_call step from a tool_use wrapper event", async () => {
    const steps: RuntimeStep[] = [];
    runCliSpy.mockImplementation(async (options) => {
      options.onLog?.(
        "stdout",
        JSON.stringify({
          type: OPENCODE_EVENT_TYPE.ToolUse,
          timestamp: 1,
          sessionID: SID,
          part: {
            id: "prt_x",
            sessionID: SID,
            messageID: "msg_1",
            type: "tool",
            tool: "read",
            state: { status: "running", input: { file_path: "/src/x.ts" } },
          },
        }) + "\n",
      );
      return MOCK_OK;
    });
    await new OpenCodeRuntime().execute(ctx({ onStep: (step) => steps.push(step) }));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("tool_call");
    expect(steps[0]!.tool).toBe("read");
    expect(steps[0]!.description).toBe("/src/x.ts");
  });

  it("maps aborted result to cancelled", async () => {
    mockRunCli({ ...MOCK_OK, aborted: true, stdout: "" });
    const result = await new OpenCodeRuntime().execute(ctx());
    expect(result.status).toBe("cancelled");
  });

  it("passes exit_code through so the daemon can persist real spawn outcome", async () => {
    mockRunCli({ ...MOCK_OK, exitCode: 7, stdout: "" });
    const result = await new OpenCodeRuntime().execute(ctx());
    expect(result.exit_code).toBe(7);
  });

  it("surfaces stderr tail on failure so /runtime/done has something actionable", async () => {
    mockRunCli({
      ...MOCK_OK,
      exitCode: 1,
      stdout: "",
      stderr: "Error: provider auth missing\n",
    });
    const result = await new OpenCodeRuntime().execute(ctx());
    expect(result.status).toBe("failed");
    expect(result.stderr).toBe("Error: provider auth missing\n");
  });

  it("does not surface stderr on success — only failures populate it", async () => {
    mockRunCli({ ...MOCK_OK, stderr: "WARN harmless\n" });
    const result = await new OpenCodeRuntime().execute(ctx());
    expect(result.status).toBe("completed");
    expect(result.stderr).toBeUndefined();
  });
});

describe("OpenCodeRuntime.healthCheck", () => {
  it("runs opencode --version", async () => {
    mockRunCli({ ...MOCK_OK, stdout: "", exitCode: 0 });
    const health = await new OpenCodeRuntime().healthCheck();
    expect(health.healthy).toBe(true);
    expect(lastOptions!.args).toEqual(["--version"]);
    expect(lastOptions!.timeoutMs).toBe(5000);
    expect(lastOptions!.graceMs).toBe(0);
  });
});

describe("buildOpenCodeConfig", () => {
  it("writes a remote Beevibe MCP server using the session env placeholder", () => {
    const parsed = JSON.parse(buildOpenCodeConfig("bv_a_test", "http://api.test/mcp"));
    expect(parsed.mcp.beevibe).toMatchObject({
      type: "remote",
      url: "http://api.test/mcp",
      enabled: true,
      oauth: false,
    });
    expect(parsed.mcp.beevibe.headers.Authorization).toBe("Bearer bv_a_test");
    expect(parsed.mcp.beevibe.headers["X-Beevibe-Session"]).toBe(
      "{env:BEEVIBE_SESSION_ID}",
    );
  });
});
