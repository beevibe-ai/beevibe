import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  parseNdjsonLine,
  runStreamingCli,
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

describe("runStreamingCli", () => {
  function context(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      workspace: { path: "/ws", id: "ws_1" },
      intent: "do the thing",
      system_prompt_append: "",
      ...overrides,
    } as RuntimeContext;
  }

  /** Drive `onLog` with the given stdout chunks, then settle. */
  function spawnEmitting(chunks: string[], result: Partial<CliProcessResult> = {}) {
    return vi
      .spyOn(spawnModule, "runCliProcess")
      .mockImplementation(async (options) => {
        for (const chunk of chunks) options.onLog?.("stdout", chunk);
        return cliResult(result);
      });
  }

  afterEach(() => vi.restoreAllMocks());

  it("collects one event per parseable line, skipping the rest", async () => {
    spawnEmitting(['{"n":1}\n', "noise\n", '{"n":2}\n']);
    const run = await runStreamingCli<{ n: number }>({
      runtimeTag: "T",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context(),
      parseLine: (l) => parseNdjsonLine<{ n: number }>(l),
      extractSteps: () => [],
    });
    expect(run.events).toEqual([{ n: 1 }, { n: 2 }]);
    expect(run.cancelled).toBeUndefined();
  });

  it("reassembles an event split across chunk boundaries", async () => {
    spawnEmitting(['{"n"', ":1}\n"]);
    const run = await runStreamingCli<{ n: number }>({
      runtimeTag: "T",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context(),
      parseLine: (l) => parseNdjsonLine<{ n: number }>(l),
      extractSteps: () => [],
    });
    expect(run.events).toEqual([{ n: 1 }]);
  });

  it("flushes a trailing line that has no final newline", async () => {
    spawnEmitting(['{"n":1}']);
    const run = await runStreamingCli<{ n: number }>({
      runtimeTag: "T",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context(),
      parseLine: (l) => parseNdjsonLine<{ n: number }>(l),
      extractSteps: () => [],
    });
    expect(run.events).toEqual([{ n: 1 }]);
  });

  it("forwards every extracted step to context.onStep in arrival order", async () => {
    spawnEmitting(['{"n":1}\n{"n":2}\n']);
    const steps: string[] = [];
    await runStreamingCli<{ n: number }>({
      runtimeTag: "T",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context({ onStep: (s) => steps.push(s.kind) }),
      parseLine: (l) => parseNdjsonLine<{ n: number }>(l),
      extractSteps: (e) =>
        [{ kind: "tool_call", label: String(e.n) }] as unknown as RuntimeStep[],
    });
    expect(steps).toEqual(["tool_call", "tool_call"]);
  });

  it("does not call extractSteps at all when no onStep is wired", async () => {
    spawnEmitting(['{"n":1}\n']);
    const extractSteps = vi.fn(() => []);
    await runStreamingCli<{ n: number }>({
      runtimeTag: "T",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context(),
      parseLine: (l) => parseNdjsonLine<{ n: number }>(l),
      extractSteps,
    });
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("renames pid/process_group_id onto context.onSpawn", async () => {
    vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
      options.onSpawn?.({ pid: 99, process_group_id: 98 });
      return cliResult();
    });
    const onSpawn = vi.fn();
    await runStreamingCli({
      runtimeTag: "T",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context({ onSpawn }),
      parseLine: () => null,
      extractSteps: () => [],
    });
    expect(onSpawn).toHaveBeenCalledWith({ process_pid: 99, process_group_id: 98 });
  });

  it("returns a cancelled result on abort, alongside whatever it parsed", async () => {
    spawnEmitting(['{"n":1}\n'], { aborted: true });
    const run = await runStreamingCli<{ n: number }>({
      runtimeTag: "T",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context(),
      parseLine: (l) => parseNdjsonLine<{ n: number }>(l),
      extractSteps: () => [],
    });
    expect(run.cancelled).toEqual({
      status: "cancelled",
      output: "Session cancelled.",
      process_pid: 4242,
      process_group_id: 4242,
    });
    // The events are still handed back — a codex-style adapter needs the
    // call to return before it can clean up its per-spawn temp file.
    expect(run.events).toEqual([{ n: 1 }]);
  });

  it("warns once, under the caller's tag, when stdout was truncated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    spawnEmitting([], { truncated: true });
    await runStreamingCli({
      runtimeTag: "CodexRuntime",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context(),
      parseLine: () => null,
      extractSteps: () => [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[CodexRuntime]");
  });

  it("passes stdin through only when given", async () => {
    const spy = spawnEmitting([]);
    const base = {
      runtimeTag: "T",
      command: "x",
      args: [],
      cwd: "/ws",
      env: {},
      context: context(),
      parseLine: () => null,
      extractSteps: () => [],
    } as const;

    await runStreamingCli({ ...base, stdin: "piped intent" });
    expect(spy.mock.calls[0]?.[0].stdin).toBe("piped intent");

    await runStreamingCli(base);
    // `undefined` is what runCliProcess already treats as "no stdin".
    expect(spy.mock.calls[1]?.[0].stdin).toBeUndefined();
  });
});
