import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as spawnModule from "./claude-code/spawn.js";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  runCliSession,
  warnIfTruncated,
} from "./runtime-common.js";

function cliResult(overrides: Partial<CliProcessResult> = {}): CliProcessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    pid: 4242,
    process_group_id: 4242,
    truncated: false,
    ...overrides,
  };
}

describe("createStdoutLineReader", () => {
  it("emits one call per complete line", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", "a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("reassembles a line split across chunks", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", '{"ty');
    reader.onLog("stdout", 'pe":"x"}');
    // Nothing emitted until the newline arrives.
    expect(lines).toEqual([]);
    reader.onLog("stdout", "\n");
    expect(lines).toEqual(['{"type":"x"}']);
  });

  it("emits several lines arriving in a single chunk", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", "one\ntwo\nthr");
    expect(lines).toEqual(["one", "two"]);
    reader.flush();
    expect(lines).toEqual(["one", "two", "thr"]);
  });

  it("ignores stderr chunks", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stderr", "warning: noise\n");
    reader.flush();
    expect(lines).toEqual([]);
  });

  it("flush is a no-op when the stream ended on a newline", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", "done\n");
    reader.flush();
    reader.flush();
    expect(lines).toEqual(["done"]);
  });

  it("preserves empty lines between records", () => {
    const lines: string[] = [];
    const reader = createStdoutLineReader((l) => lines.push(l));
    reader.onLog("stdout", "a\n\nb\n");
    expect(lines).toEqual(["a", "", "b"]);
  });
});

describe("warnIfTruncated", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns with the runtime tag when stdout was capped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfTruncated("CodexRuntime", cliResult({ truncated: true }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[CodexRuntime]");
  });

  it("stays quiet when the stream was complete", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfTruncated("CodexRuntime", cliResult({ truncated: false }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("cancelledResult", () => {
  it("reports cancelled — distinct from a failure — with process metadata", () => {
    expect(cancelledResult(cliResult({ aborted: true }))).toEqual({
      status: "cancelled",
      output: "Session cancelled.",
      process_pid: 4242,
      process_group_id: 4242,
    });
  });

  it("maps a null pid (spawn failure) to undefined", () => {
    const result = cancelledResult(cliResult({ pid: null, process_group_id: null }));
    expect(result.process_pid).toBeUndefined();
    expect(result.process_group_id).toBeUndefined();
  });
});

describe("finalizeCliResult", () => {
  const parsed: RuntimeResult = { status: "completed", output: "hi" };

  it("merges process metadata onto the parsed result", () => {
    expect(finalizeCliResult(parsed, cliResult({ exitCode: 0 }))).toEqual({
      status: "completed",
      output: "hi",
      process_pid: 4242,
      process_group_id: 4242,
      exit_code: 0,
    });
  });

  it("omits stderr when the run succeeded", () => {
    const out = finalizeCliResult(parsed, cliResult({ stderr: "chatty but fine" }));
    expect(out.stderr).toBeUndefined();
  });

  it("surfaces the stderr tail on failure", () => {
    const failed: RuntimeResult = { status: "failed", output: "" };
    const out = finalizeCliResult(failed, cliResult({ stderr: "boom", exitCode: 1 }));
    expect(out.stderr).toBe("boom");
    expect(out.exit_code).toBe(1);
  });

  it("tail-slices stderr to 4KB, keeping the end where the error is", () => {
    const failed: RuntimeResult = { status: "failed", output: "" };
    const stderr = "x".repeat(5000) + "FINAL_ERROR";
    const out = finalizeCliResult(failed, cliResult({ stderr, exitCode: 1 }));
    expect(out.stderr).toHaveLength(4096);
    expect(out.stderr!.endsWith("FINAL_ERROR")).toBe(true);
  });

  it("omits stderr on failure when the CLI wrote nothing", () => {
    const failed: RuntimeResult = { status: "failed", output: "" };
    expect(finalizeCliResult(failed, cliResult({ stderr: "", exitCode: 1 })).stderr).toBeUndefined();
  });
});

describe("runCliSession", () => {
  interface TestEvent {
    n: number;
  }

  let runCliSpy: ReturnType<typeof vi.spyOn>;
  let lastOptions: CliProcessOptions | undefined;

  function mockRunCli(result: CliProcessResult): void {
    runCliSpy.mockImplementation(async (options) => {
      lastOptions = options;
      if (result.pid !== null) {
        options.onSpawn?.({
          pid: result.pid,
          process_group_id: result.process_group_id ?? result.pid,
        });
      }
      if (result.stdout) options.onLog?.("stdout", result.stdout);
      return result;
    });
  }

  function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      intent: "do a thing",
      workspace: { path: "/tmp/beevibe-run-cli-session-test" },
      system_prompt_append: "",
      ...overrides,
    };
  }

  function spec(overrides: Record<string, unknown> = {}) {
    return {
      runtimeTag: "TestRuntime",
      command: "testcli",
      args: ["--json"],
      cwd: "/tmp/beevibe-run-cli-session-test",
      env: { PATH: "/usr/bin" },
      parseLine: (line: string) =>
        line.trim() ? ({ n: Number(line.trim()) } as TestEvent) : null,
      extractSteps: (e: TestEvent): RuntimeStep[] => [
        { kind: "agent", description: `step ${e.n}`, timestamp: "t" },
      ],
      buildResult: (events: TestEvent[], exitCode: number | null) => ({
        status: exitCode === 0 ? ("completed" as const) : ("failed" as const),
        output: events.map((e) => e.n).join(","),
      }),
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

  it("passes the spec's argv, cwd, env and stdin through to the process", async () => {
    mockRunCli(cliResult());
    await runCliSession<TestEvent>(ctx(), spec({ stdin: "piped intent" }));
    expect(lastOptions?.command).toBe("testcli");
    expect(lastOptions?.args).toEqual(["--json"]);
    expect(lastOptions?.cwd).toBe("/tmp/beevibe-run-cli-session-test");
    expect(lastOptions?.env).toEqual({ PATH: "/usr/bin" });
    expect(lastOptions?.stdin).toBe("piped intent");
  });

  it("builds the result from every parsed event", async () => {
    mockRunCli(cliResult({ stdout: "1\n2\n3\n" }));
    const result = await runCliSession<TestEvent>(ctx(), spec());
    expect(result.status).toBe("completed");
    expect(result.output).toBe("1,2,3");
  });

  // The stream can end without a trailing newline; the final partial line
  // has to reach `buildResult` rather than being dropped on the floor.
  it("includes a trailing line that arrived without a newline", async () => {
    mockRunCli(cliResult({ stdout: "1\n2" }));
    const result = await runCliSession<TestEvent>(ctx(), spec());
    expect(result.output).toBe("1,2");
  });

  it("fans each event's steps out to context.onStep as they arrive", async () => {
    mockRunCli(cliResult({ stdout: "7\n8\n" }));
    const steps: RuntimeStep[] = [];
    await runCliSession<TestEvent>(ctx({ onStep: (s) => steps.push(s) }), spec());
    expect(steps.map((s) => s.description)).toEqual(["step 7", "step 8"]);
  });

  it("skips lines the spec's parser rejects", async () => {
    mockRunCli(cliResult({ stdout: "1\n\n2\n" }));
    const result = await runCliSession<TestEvent>(ctx(), spec());
    expect(result.output).toBe("1,2");
  });

  it("forwards the spawned pid to context.onSpawn", async () => {
    mockRunCli(cliResult({ pid: 321, process_group_id: 321 }));
    const spawns: Array<{ process_pid: number }> = [];
    await runCliSession<TestEvent>(
      ctx({ onSpawn: (s) => spawns.push(s as { process_pid: number }) }),
      spec(),
    );
    expect(spawns).toEqual([{ process_pid: 321, process_group_id: 321 }]);
  });

  it("merges the process metadata into the built result", async () => {
    mockRunCli(cliResult({ stdout: "5\n", pid: 777, process_group_id: 778, exitCode: 0 }));
    const result = await runCliSession<TestEvent>(ctx(), spec());
    expect(result.process_pid).toBe(777);
    expect(result.process_group_id).toBe(778);
    expect(result.exit_code).toBe(0);
  });

  it("maps an aborted process to cancelled without consulting buildResult", async () => {
    mockRunCli(cliResult({ aborted: true, stdout: "1\n" }));
    const buildResult = vi.fn();
    const result = await runCliSession<TestEvent>(ctx(), spec({ buildResult }));
    expect(result.status).toBe("cancelled");
    expect(buildResult).not.toHaveBeenCalled();
  });

  it("surfaces the stderr tail when the spec reports failure", async () => {
    mockRunCli(cliResult({ exitCode: 3, stderr: "boom\n" }));
    const result = await runCliSession<TestEvent>(ctx(), spec());
    expect(result.status).toBe("failed");
    expect(result.stderr).toBe("boom\n");
  });

  it("warns once when stdout hit the capture cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunCli(cliResult({ truncated: true }));
    await runCliSession<TestEvent>(ctx(), spec());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[TestRuntime]");
    warn.mockRestore();
  });

  // Codex reads and deletes its `--output-last-message` file here, and the
  // file has to be cleaned up whether the run finished or was cancelled.
  it("runs onSettled before the result is built", async () => {
    mockRunCli(cliResult({ stdout: "1\n" }));
    const order: string[] = [];
    await runCliSession<TestEvent>(
      ctx(),
      spec({
        onSettled: () => order.push("settled"),
        buildResult: () => {
          order.push("built");
          return { status: "completed" as const, output: "" };
        },
      }),
    );
    expect(order).toEqual(["settled", "built"]);
  });

  it("runs onSettled on the aborted path too", async () => {
    mockRunCli(cliResult({ aborted: true }));
    const onSettled = vi.fn();
    const result = await runCliSession<TestEvent>(ctx(), spec({ onSettled }));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("cancelled");
  });
});
