import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  parseNdjsonLine,
  runStreamingCliSession,
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

describe("runStreamingCliSession", () => {
  let runCliSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    runCliSpy?.mockRestore();
  });

  /** Replay `result.stdout` through the handler's own onLog, as the real spawn does. */
  function mockSpawn(result: CliProcessResult): { options: () => CliProcessOptions } {
    let seen: CliProcessOptions | undefined;
    runCliSpy = vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
      seen = options;
      if (result.pid !== null) {
        options.onSpawn?.({
          pid: result.pid,
          process_group_id: result.process_group_id ?? result.pid,
        });
      }
      if (result.stdout) options.onLog?.("stdout", result.stdout);
      return result;
    });
    return { options: () => seen as CliProcessOptions };
  }

  interface Evt {
    n: number;
  }

  function session(
    overrides: Partial<Parameters<typeof runStreamingCliSession<Evt>>[0]> = {},
  ): Promise<RuntimeResult> {
    return runStreamingCliSession<Evt>({
      runtimeTag: "TestRuntime",
      context: {
        intent: "do a thing",
        workspace: { path: "/tmp/ws" },
        system_prompt_append: "",
      },
      spawn: { command: "fake-cli", args: ["--go"], cwd: "/tmp/ws" },
      parseLine: (line) => parseNdjsonLine<Evt>(line),
      extractSteps: (e) => [{ kind: "agent", description: `n=${e.n}`, timestamp: "t" }],
      toResult: (events) => ({
        status: "completed",
        output: events.map((e) => e.n).join(","),
      }),
      ...overrides,
    });
  }

  it("parses every line into the event stream handed to toResult", async () => {
    mockSpawn(cliResult({ stdout: '{"n":1}\n{"n":2}\n{"n":3}\n' }));
    const result = await session();
    expect(result.output).toBe("1,2,3");
  });

  // The flush is the part that was written out three times and could be
  // forgotten once: a stream that ends without a newline still has an event
  // in the buffer.
  it("flushes a trailing line that arrived without a newline", async () => {
    mockSpawn(cliResult({ stdout: '{"n":1}\n{"n":2}' }));
    const result = await session();
    expect(result.output).toBe("1,2");
  });

  it("skips lines parseLine rejects rather than failing the run", async () => {
    mockSpawn(cliResult({ stdout: 'warning: not json\n{"n":7}\n\n' }));
    const result = await session();
    expect(result.output).toBe("7");
  });

  it("streams steps to context.onStep as lines arrive", async () => {
    mockSpawn(cliResult({ stdout: '{"n":1}\n{"n":2}\n' }));
    const steps: RuntimeStep[] = [];
    await session({
      context: {
        intent: "i",
        workspace: { path: "/tmp/ws" },
        system_prompt_append: "",
        onStep: (s) => steps.push(s),
      },
    });
    expect(steps.map((s) => s.description)).toEqual(["n=1", "n=2"]);
  });

  it("does not call extractSteps when the caller wants no steps", async () => {
    mockSpawn(cliResult({ stdout: '{"n":1}\n' }));
    const extractSteps = vi.fn(() => []);
    await session({ extractSteps });
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("forwards the caller's spawn options and supplies the three it owns", async () => {
    const spawned = mockSpawn(cliResult({ stdout: '{"n":1}\n' }));
    const signal = new AbortController().signal;
    const onSpawn = vi.fn();
    await session({
      context: {
        intent: "i",
        workspace: { path: "/tmp/ws" },
        system_prompt_append: "",
        abort_signal: signal,
        onSpawn,
      },
      spawn: { command: "fake-cli", args: ["--go"], cwd: "/tmp/ws", stdin: "piped" },
    });
    const opts = spawned.options();
    expect(opts.command).toBe("fake-cli");
    expect(opts.stdin).toBe("piped");
    expect(opts.abortSignal).toBe(signal);
    expect(onSpawn).toHaveBeenCalledWith({ process_pid: 4242, process_group_id: 4242 });
  });

  it("merges process metadata into the parsed result", async () => {
    mockSpawn(cliResult({ stdout: '{"n":1}\n', exitCode: 0, pid: 77, process_group_id: 77 }));
    const result = await session();
    expect(result).toMatchObject({ process_pid: 77, process_group_id: 77, exit_code: 0 });
  });

  // An abort has to short-circuit ahead of the parse, so the session is
  // reported cancelled rather than as whatever partial output arrived.
  it("returns a cancelled result on abort without calling toResult", async () => {
    mockSpawn(cliResult({ stdout: '{"n":1}\n', aborted: true, exitCode: null }));
    const toResult = vi.fn();
    const result = await session({ toResult });
    expect(result.status).toBe("cancelled");
    expect(toResult).not.toHaveBeenCalled();
  });

  it("runs onAbort on the cancelled path only", async () => {
    mockSpawn(cliResult({ stdout: "", aborted: true }));
    const onAbort = vi.fn();
    await session({ onAbort });
    expect(onAbort).toHaveBeenCalledOnce();

    runCliSpy.mockRestore();
    mockSpawn(cliResult({ stdout: '{"n":1}\n' }));
    const onAbort2 = vi.fn();
    await session({ onAbort: onAbort2 });
    expect(onAbort2).not.toHaveBeenCalled();
  });

  it("warns once when stdout hit the capture cap", async () => {
    mockSpawn(cliResult({ stdout: '{"n":1}\n', truncated: true }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await session();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[TestRuntime]"));
    warn.mockRestore();
  });
});
