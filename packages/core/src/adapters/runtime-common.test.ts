import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  buildChildEnv,
  cancelledResult,
  createNdjsonEventCollector,
  createStdoutLineReader,
  finalizeCliResult,
  forwardSpawn,
  parseNdjsonLine,
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

describe("createNdjsonEventCollector", () => {
  interface Evt {
    type: string;
    text?: string;
  }

  const collector = (onStep?: (step: RuntimeStep) => void) =>
    createNdjsonEventCollector<Evt>({
      parse: (line) => parseNdjsonLine<Evt>(line),
      extractSteps: (evt) =>
        evt.text ? [{ kind: "agent", description: evt.text, timestamp: "t" }] : [],
      onStep,
    });

  it("collects parsed events in arrival order", () => {
    const c = collector();
    c.onLog("stdout", '{"type":"a"}\n{"type":"b"}\n');
    expect(c.events).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("skips lines the parser rejects rather than failing the run", () => {
    const c = collector();
    c.onLog("stdout", "plain log noise\n{bad json}\n{\"type\":\"ok\"}\n");
    expect(c.events).toEqual([{ type: "ok" }]);
  });

  it("forwards steps as lines arrive, not only at flush", () => {
    const steps: RuntimeStep[] = [];
    const c = collector((s) => steps.push(s));
    c.onLog("stdout", '{"type":"a","text":"hello"}\n');
    expect(steps).toEqual([{ kind: "agent", description: "hello", timestamp: "t" }]);
  });

  it("still collects events when no onStep is subscribed", () => {
    const c = collector();
    c.onLog("stdout", '{"type":"a","text":"hello"}\n');
    expect(c.events).toHaveLength(1);
  });

  it("flush picks up a trailing line with no newline", () => {
    const c = collector();
    c.onLog("stdout", '{"type":"last"}');
    expect(c.events).toEqual([]);
    c.flush();
    expect(c.events).toEqual([{ type: "last" }]);
  });
});

describe("buildChildEnv", () => {
  const ORIGINAL = process.env.BV_TEST_VAR;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BV_TEST_VAR;
    else process.env.BV_TEST_VAR = ORIGINAL;
  });

  it("inherits the parent environment", () => {
    process.env.BV_TEST_VAR = "inherited";
    expect(buildChildEnv({}).BV_TEST_VAR).toBe("inherited");
  });

  it("strips the named variables", () => {
    process.env.BV_TEST_VAR = "leaked";
    expect(buildChildEnv({}, ["BV_TEST_VAR"])).not.toHaveProperty("BV_TEST_VAR");
  });

  it("lets an explicit context override win over the strip list", () => {
    process.env.BV_TEST_VAR = "leaked";
    const env = buildChildEnv({ env: { BV_TEST_VAR: "chosen" } }, ["BV_TEST_VAR"]);
    expect(env.BV_TEST_VAR).toBe("chosen");
  });

  it("does not mutate process.env", () => {
    process.env.BV_TEST_VAR = "kept";
    buildChildEnv({ env: { BV_TEST_VAR: "other" } }, ["BV_TEST_VAR"]);
    expect(process.env.BV_TEST_VAR).toBe("kept");
  });
});

describe("forwardSpawn", () => {
  it("renames pid to process_pid for the context callback", () => {
    const seen: Array<{ process_pid: number; process_group_id: number }> = [];
    const handler = forwardSpawn({ onSpawn: (meta) => seen.push(meta) });
    handler!({ pid: 99, process_group_id: 98 });
    expect(seen).toEqual([{ process_pid: 99, process_group_id: 98 }]);
  });

  it("returns undefined when the context wants no notification", () => {
    expect(forwardSpawn({})).toBeUndefined();
  });
});
