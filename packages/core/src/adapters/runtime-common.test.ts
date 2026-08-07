import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  cancelledResult,
  createEventStream,
  createStdoutLineReader,
  finalizeCliResult,
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

describe("createEventStream", () => {
  interface Evt {
    n: number;
  }

  const parseLine = (line: string): Evt | null =>
    line.startsWith("evt:") ? { n: Number(line.slice(4)) } : null;
  const extractSteps = (evt: Evt): RuntimeStep[] =>
    [{ kind: "text", content: String(evt.n) } as unknown as RuntimeStep];

  function ctx(onStep?: (step: RuntimeStep) => void): RuntimeContext {
    return { onStep } as unknown as RuntimeContext;
  }

  it("collects parsed events in arrival order across chunk boundaries", () => {
    const stream = createEventStream(ctx(), parseLine, extractSteps);
    stream.onLog("stdout", "evt:1\nev");
    stream.onLog("stdout", "t:2\n");
    expect(stream.events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("drops lines the parser rejects instead of failing the run", () => {
    const stream = createEventStream(ctx(), parseLine, extractSteps);
    stream.onLog("stdout", "some npm warning\nevt:7\n");
    expect(stream.events).toEqual([{ n: 7 }]);
  });

  it("fans each event out through extractSteps when onStep is set", () => {
    const steps: RuntimeStep[] = [];
    const stream = createEventStream(ctx((s) => steps.push(s)), parseLine, extractSteps);
    stream.onLog("stdout", "evt:1\nevt:2\n");
    expect(steps.map((s) => (s as { content: string }).content)).toEqual(["1", "2"]);
  });

  // The adapters guard on `onStep` before calling extract* — a runtime with
  // no step consumer shouldn't pay for the per-event derivation at all.
  it("skips extractSteps entirely when there is no onStep", () => {
    const extract = vi.fn(extractSteps);
    const stream = createEventStream(ctx(), parseLine, extract);
    stream.onLog("stdout", "evt:1\n");
    expect(stream.events).toHaveLength(1);
    expect(extract).not.toHaveBeenCalled();
  });

  it("ignores stderr", () => {
    const stream = createEventStream(ctx(), parseLine, extractSteps);
    stream.onLog("stderr", "evt:9\n");
    expect(stream.events).toEqual([]);
  });

  it("emits a trailing line with no newline only on flush", () => {
    const stream = createEventStream(ctx(), parseLine, extractSteps);
    stream.onLog("stdout", "evt:3");
    expect(stream.events).toEqual([]);
    stream.flush();
    expect(stream.events).toEqual([{ n: 3 }]);
  });

  it("is a no-op when flushed with nothing pending", () => {
    const stream = createEventStream(ctx(), parseLine, extractSteps);
    stream.onLog("stdout", "evt:4\n");
    stream.flush();
    stream.flush();
    expect(stream.events).toEqual([{ n: 4 }]);
  });
});
