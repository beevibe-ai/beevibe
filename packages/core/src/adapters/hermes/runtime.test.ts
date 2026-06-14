import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext, RuntimeStep } from "../../ports/runtime.js";
import type { CliProcessOptions, CliProcessResult } from "../claude-code/spawn.js";
import * as spawnModule from "../claude-code/spawn.js";
import { HermesRuntime, stripAnsi } from "./runtime.js";

const MOCK_OK: CliProcessResult = {
  stdout: "Done.\n",
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
      options.onSpawn?.({
        pid: result.pid,
        process_group_id: result.process_group_id ?? result.pid,
      });
    }
    if (result.stdout) options.onLog?.("stdout", result.stdout);
    if (result.stderr) options.onLog?.("stderr", result.stderr);
    return result;
  });
}

function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    intent: "teach me this page",
    workspace: { path: "/tmp/beevibe-hermes-test-ws" },
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

describe("HermesRuntime.execute", () => {
  it("runs hermes chat in quiet one-shot mode with browser-capable toolsets", async () => {
    mockRunCli();
    await new HermesRuntime().execute(ctx({ workspace: { path: "/agents/hermes" } }));
    expect(lastOptions?.cwd).toBe("/agents/hermes");
    expect(lastOptions?.args?.slice(0, 8)).toEqual([
      "chat",
      "--quiet",
      "--source",
      "beevibe",
      "--toolsets",
      "browser,web,terminal,skills",
      "-q",
      "teach me this page",
    ]);
  });

  it("allows constructor toolsets to override the browser default", async () => {
    mockRunCli();
    await new HermesRuntime({ toolsets: "web,skills" }).execute(ctx());
    const idx = lastOptions!.args!.indexOf("--toolsets");
    expect(lastOptions!.args![idx + 1]).toBe("web,skills");
  });

  it("passes provider, model, max turns, and resume flags through to Hermes", async () => {
    mockRunCli();
    await new HermesRuntime({ provider: "nous", model: "fallback" }).execute(
      ctx({
        model: "anthropic/claude-sonnet-4.6",
        max_turns: 12,
        resume_session_id: "lesson-session",
      }),
    );
    expect(lastOptions!.args).toContain("--provider");
    expect(lastOptions!.args).toContain("nous");
    expect(lastOptions!.args).toContain("--model");
    expect(lastOptions!.args).toContain("anthropic/claude-sonnet-4.6");
    expect(lastOptions!.args).toContain("--max-turns");
    expect(lastOptions!.args).toContain("12");
    expect(lastOptions!.args).toContain("--resume");
    expect(lastOptions!.args).toContain("lesson-session");
  });

  it("folds system_prompt_append into the one-shot query", async () => {
    mockRunCli();
    await new HermesRuntime().execute(
      ctx({ intent: "explain this", system_prompt_append: "<memory>knows React</memory>" }),
    );
    const prompt = lastOptions!.args!.at(-1)!;
    expect(prompt).toContain("<beevibe_system_context>");
    expect(prompt).toContain("<memory>knows React</memory>");
    expect(prompt).toContain("explain this");
  });

  it("merges context.env into the spawned process env", async () => {
    mockRunCli();
    await new HermesRuntime().execute(ctx({ env: { BEEVIBE_SESSION_ID: "sess_123" } }));
    expect(lastOptions!.env!.BEEVIBE_SESSION_ID).toBe("sess_123");
  });

  it("emits stdout lines as agent steps after stripping ANSI formatting", async () => {
    const steps: RuntimeStep[] = [];
    mockRunCli({
      ...MOCK_OK,
      stdout: "\u001b[32mLooking at the page\u001b[0m\nNow explaining it\n",
    });
    await new HermesRuntime().execute(ctx({ onStep: (s) => steps.push(s) }));
    expect(steps.map((s) => s.description)).toEqual(["Looking at the page", "Now explaining it"]);
    expect(steps.every((s) => s.kind === "agent")).toBe(true);
  });

  it("maps successful stdout to the final RuntimeResult", async () => {
    mockRunCli({ ...MOCK_OK, stdout: "\u001b[1mFinal answer\u001b[0m\n" });
    const result = await new HermesRuntime().execute(ctx());
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Final answer");
    expect(result.transcript).toBe("Final answer");
    expect(result.exit_code).toBe(0);
  });

  it("maps aborted result to cancelled", async () => {
    mockRunCli({ ...MOCK_OK, aborted: true, stdout: "" });
    const result = await new HermesRuntime().execute(ctx());
    expect(result.status).toBe("cancelled");
  });

  it("surfaces stderr tail on failure", async () => {
    mockRunCli({
      ...MOCK_OK,
      stdout: "",
      stderr: "Error: Browser Use is not configured\n",
      exitCode: 1,
    });
    const result = await new HermesRuntime().execute(ctx());
    expect(result.status).toBe("failed");
    expect(result.output).toBe("Error: Browser Use is not configured");
    expect(result.stderr).toBe("Error: Browser Use is not configured");
    expect(result.exit_code).toBe(1);
  });
});

describe("HermesRuntime.healthCheck", () => {
  it("runs hermes --version", async () => {
    mockRunCli({ ...MOCK_OK, stdout: "hermes 1.2.3\n", exitCode: 0 });
    const health = await new HermesRuntime().healthCheck();
    expect(health.healthy).toBe(true);
    expect(lastOptions!.args).toEqual(["--version"]);
    expect(lastOptions!.timeoutMs).toBe(5000);
    expect(lastOptions!.graceMs).toBe(0);
  });
});

describe("stripAnsi", () => {
  it("removes terminal escape sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });
});
