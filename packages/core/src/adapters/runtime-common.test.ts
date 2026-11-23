import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  runCliRuntimeSession,
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

describe("runCliRuntimeSession", () => {
  interface Evt {
    n: number;
  }

  function context(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      intent: "do the thing",
      system_prompt_append: "",
      workspace: { path: "/tmp/ws" },
      ...overrides,
    } as RuntimeContext;
  }

  /**
   * Stub `runCliProcess` so it replays `stdout` through the caller's
   * `onLog` the way a real subprocess would, then resolves with `result`.
   * `chunks` lets a test split the stream at arbitrary byte boundaries.
   */
  function mockSpawn(
    chunks: string[],
    result: Partial<CliProcessResult> = {},
  ): { options: () => CliProcessOptions | undefined } {
    let seen: CliProcessOptions | undefined;
    vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
      seen = options;
      options.onSpawn?.({ pid: 4242, process_group_id: 4242 });
      for (const chunk of chunks) options.onLog?.("stdout", chunk);
      return cliResult({ stdout: chunks.join(""), ...result });
    });
    return { options: () => seen };
  }

  const parseLine = (line: string): Evt | null => {
    const trimmed = line.trim();
    return trimmed ? ({ n: Number(trimmed) } as Evt) : null;
  };

  function session(
    opts: Partial<Parameters<typeof runCliRuntimeSession<Evt>>[0]> = {},
  ): Promise<RuntimeResult> {
    return runCliRuntimeSession<Evt>({
      runtimeTag: "TestRuntime",
      command: "fake-cli",
      args: ["--json"],
      env: {},
      context: context(),
      parseLine,
      extractSteps: () => [],
      buildResult: (events) => ({
        status: "completed",
        output: events.map((e) => e.n).join(","),
      }),
      ...opts,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects every event and hands them to buildResult in order", async () => {
    mockSpawn(["1\n2\n3\n"]);
    const result = await session();
    expect(result.output).toBe("1,2,3");
    expect(result.status).toBe("completed");
  });

  it("reassembles events split across chunk boundaries", async () => {
    mockSpawn(["1", "0\n2", "0\n"]);
    const result = await session();
    expect(result.output).toBe("10,20");
  });

  it("flushes a trailing line that arrives without a newline", async () => {
    // The bug each hand-rolled copy of this plumbing could reintroduce by
    // forgetting stdout.flush(): the final event is silently dropped.
    mockSpawn(["1\n2\n3"]);
    const result = await session();
    expect(result.output).toBe("1,2,3");
  });

  it("skips lines parseLine rejects", async () => {
    mockSpawn(["1\n\n   \n2\n"]);
    const result = await session();
    expect(result.output).toBe("1,2");
  });

  it("fans each event out to context.onStep as it arrives", async () => {
    mockSpawn(["1\n2\n"]);
    const steps: RuntimeStep[] = [];
    await session({
      context: context({ onStep: (s) => steps.push(s) }),
      extractSteps: (e) => [
        { kind: "agent", description: String(e.n), timestamp: "t" },
      ],
    });
    expect(steps.map((s) => s.description)).toEqual(["1", "2"]);
  });

  it("does not call extractSteps when there is no onStep listener", async () => {
    mockSpawn(["1\n"]);
    const extractSteps = vi.fn(() => []);
    await session({ extractSteps });
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("merges process metadata and the exit code into the result", async () => {
    mockSpawn(["1\n"], { exitCode: 0 });
    const result = await session();
    expect(result.process_pid).toBe(4242);
    expect(result.process_group_id).toBe(4242);
    expect(result.exit_code).toBe(0);
  });

  it("surfaces the stderr tail when the parsed result failed", async () => {
    mockSpawn(["1\n"], { exitCode: 2, stderr: "boom" });
    const result = await session({
      buildResult: () => ({ status: "failed", output: "nope" }),
    });
    expect(result.stderr).toBe("boom");
  });

  it("maps an aborted run to cancelled without building a result", async () => {
    mockSpawn(["1\n"], { aborted: true });
    const buildResult = vi.fn(() => ({ status: "completed" as const, output: "x" }));
    const result = await session({ buildResult });
    expect(result.status).toBe("cancelled");
    expect(result.output).toBe("Session cancelled.");
    expect(buildResult).not.toHaveBeenCalled();
  });

  it("runs cleanup on the aborted path too", async () => {
    mockSpawn([], { aborted: true });
    const cleanup = vi.fn();
    await session({ cleanup });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup after buildResult, so buildResult can still read what it removes", async () => {
    mockSpawn(["1\n"]);
    const order: string[] = [];
    await session({
      buildResult: () => {
        order.push("build");
        return { status: "completed", output: "x" };
      },
      cleanup: () => order.push("cleanup"),
    });
    expect(order).toEqual(["build", "cleanup"]);
  });

  it("passes command, args, env, cwd and abort signal through to the spawn", async () => {
    const spawn = mockSpawn([]);
    const signal = new AbortController().signal;
    await session({
      command: "codex",
      args: ["exec", "--json"],
      env: { FOO: "bar" },
      context: context({ abort_signal: signal }),
    });
    const options = spawn.options();
    expect(options?.command).toBe("codex");
    expect(options?.args).toEqual(["exec", "--json"]);
    expect(options?.env).toEqual({ FOO: "bar" });
    expect(options?.cwd).toBe("/tmp/ws");
    expect(options?.abortSignal).toBe(signal);
  });

  it("pipes stdin only when the caller sets it", async () => {
    const withStdin = mockSpawn([]);
    await session({ stdin: "the intent" });
    expect(withStdin.options()?.stdin).toBe("the intent");

    vi.restoreAllMocks();
    const withoutStdin = mockSpawn([]);
    await session();
    expect(withoutStdin.options()).not.toHaveProperty("stdin");
  });

  it("forwards the spawned pid to context.onSpawn", async () => {
    mockSpawn([]);
    const onSpawn = vi.fn();
    await session({ context: context({ onSpawn }) });
    expect(onSpawn).toHaveBeenCalledWith({ process_pid: 4242, process_group_id: 4242 });
  });

  it("warns once when the CLI's stdout was truncated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSpawn(["1\n"], { truncated: true });
    await session();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[TestRuntime]");
  });
});
