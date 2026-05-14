import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext, RuntimeStep } from "../../ports/runtime.js";
import { OpenCodeRuntime, buildOpenCodeConfig } from "./runtime.js";
import type { CliProcessOptions, CliProcessResult } from "../claude-code/spawn.js";
import * as spawnModule from "../claude-code/spawn.js";

const MOCK_OK: CliProcessResult = {
  stdout:
    JSON.stringify({
      type: "result",
      session_id: "opencode_sess_mock",
      output: "done",
      model: "openrouter/qwen/qwen3-coder",
      usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0 },
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
  it("runs opencode non-interactively with raw JSON events", async () => {
    mockRunCli();
    await new OpenCodeRuntime().execute(ctx({ workspace: { path: "/sandbox/agent_op" } }));
    expect(lastOptions?.cwd).toBe("/sandbox/agent_op");
    expect(lastOptions?.args?.slice(0, 4)).toEqual([
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
    ]);
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

  it("parses result events into RuntimeResult", async () => {
    mockRunCli();
    const result = await new OpenCodeRuntime().execute(ctx());
    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");
    expect(result.cli_session_id).toBe("opencode_sess_mock");
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd: 0,
      model: "openrouter/qwen/qwen3-coder",
    });
  });

  it("emits tool steps from flexible JSON event shapes", async () => {
    const steps: RuntimeStep[] = [];
    runCliSpy.mockImplementation(async (options) => {
      options.onLog?.(
        "stdout",
        JSON.stringify({
          type: "tool_call",
          tool: "read",
          input: { file_path: "/src/x.ts" },
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
