import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  cancelledResult,
  createEventCollector,
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

describe("createEventCollector", () => {
  interface Evt {
    n: number;
  }
  const parse = (line: string): Evt | null => {
    const n = Number(line);
    return Number.isFinite(n) && line.trim() !== "" ? { n } : null;
  };
  const steps = (e: Evt): RuntimeStep[] =>
    [{ kind: "text", text: `step ${e.n}`, at: "now" } as unknown as RuntimeStep];

  it("collects every parsed event in stream order", () => {
    const c = createEventCollector(parse, steps, undefined);
    c.onLog("stdout", "1\n2\n3\n");
    expect(c.events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("streams a step per event as it arrives, not after flush", () => {
    const seen: RuntimeStep[] = [];
    const c = createEventCollector(parse, steps, (s) => seen.push(s));
    c.onLog("stdout", "1\n");
    expect(seen).toHaveLength(1);
    c.onLog("stdout", "2\n");
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => (s as unknown as { text: string }).text)).toEqual([
      "step 1",
      "step 2",
    ]);
  });

  it("skips an unparseable line without aborting the stream", () => {
    const c = createEventCollector(parse, steps, undefined);
    c.onLog("stdout", "1\nnot a number\n2\n");
    expect(c.events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("reassembles an event split across chunk boundaries", () => {
    const c = createEventCollector(parse, steps, undefined);
    c.onLog("stdout", "12");
    c.onLog("stdout", "3\n");
    expect(c.events).toEqual([{ n: 123 }]);
  });

  it("emits a trailing partial line only on flush", () => {
    const c = createEventCollector(parse, steps, undefined);
    c.onLog("stdout", "7");
    expect(c.events).toEqual([]);
    c.flush();
    expect(c.events).toEqual([{ n: 7 }]);
  });

  it("ignores stderr", () => {
    const c = createEventCollector(parse, steps, undefined);
    c.onLog("stderr", "1\n");
    expect(c.events).toEqual([]);
  });

  it("does not call extractSteps at all when there is no onStep", () => {
    const extract = vi.fn(steps);
    const c = createEventCollector(parse, extract, undefined);
    c.onLog("stdout", "1\n2\n");
    expect(c.events).toHaveLength(2);
    expect(extract).not.toHaveBeenCalled();
  });

  it("appends the event before streaming its steps", () => {
    // An onStep that reads back `events` must already see the event that
    // produced the step — the parsed result is built from this list, so a
    // consumer correlating the two would otherwise be off by one.
    const lengths: number[] = [];
    const c = createEventCollector(parse, steps, () => lengths.push(c.events.length));
    c.onLog("stdout", "1\n2\n");
    expect(lengths).toEqual([1, 2]);
  });
});
