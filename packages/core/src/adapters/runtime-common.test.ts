import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
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

/**
 * `runCliSession` owns a short but strictly-ordered sequence that the
 * three CLI adapters used to each spell out. These tests pin the order,
 * since getting it wrong drops results rather than failing loudly.
 */
describe("runCliSession", () => {
  interface TestEvent {
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

  /** Stub `runCliProcess`, feeding `stdout` to the caller's `onLog`. */
  function stubCli(stdout: string, result: Partial<CliProcessResult> = {}) {
    return vi
      .spyOn(spawnModule, "runCliProcess")
      .mockImplementation(async (opts: CliProcessOptions) => {
        opts.onSpawn?.({ pid: 111, process_group_id: 111 });
        opts.onLog?.("stderr", "ignored\n");
        opts.onLog?.("stdout", stdout);
        return cliResult(result);
      });
  }

  const spec = (overrides: Record<string, unknown> = {}) => ({
    runtimeTag: "TestRuntime",
    context: context(),
    command: "testcli",
    args: ["--json"],
    cwd: "/tmp/ws",
    env: {},
    parseLine: (line: string): TestEvent | null =>
      line.trim() ? ({ n: Number(line) } as TestEvent) : null,
    extractSteps: (e: TestEvent): RuntimeStep[] => [
      { kind: "agent", description: String(e.n), timestamp: "t" },
    ],
    parseResult: (events: TestEvent[]): Omit<RuntimeResult, "process_pid" | "process_group_id"> => ({
      status: "completed",
      output: events.map((e) => e.n).join(","),
    }),
    ...overrides,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates parsed events and merges in the process metadata", async () => {
    stubCli("1\n2\n3\n");
    const out = await runCliSession<TestEvent>(spec() as never);
    expect(out.output).toBe("1,2,3");
    // pid/pgid are read off the settled CliProcessResult, not off the
    // earlier onSpawn callback — the two agree in production.
    expect(out.process_pid).toBe(4242);
    expect(out.process_group_id).toBe(4242);
    expect(out.exit_code).toBe(0);
  });

  it("flushes the trailing partial line, so a stream without a final newline keeps its last event", async () => {
    stubCli("1\n2\n3");
    const out = await runCliSession<TestEvent>(spec() as never);
    expect(out.output).toBe("1,2,3");
  });

  it("streams a step per event when onStep is set, and skips stderr", async () => {
    stubCli("7\n8\n");
    const steps: RuntimeStep[] = [];
    const out = await runCliSession<TestEvent>(
      spec({ context: context({ onStep: (s: RuntimeStep) => steps.push(s) }) }) as never,
    );
    expect(steps.map((s) => s.description)).toEqual(["7", "8"]);
    expect(out.output).toBe("7,8");
  });

  it("does not call extractSteps at all when onStep is unset", async () => {
    stubCli("1\n");
    const extractSteps = vi.fn(() => []);
    await runCliSession<TestEvent>(spec({ extractSteps }) as never);
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("forwards the spawn callback to the context", async () => {
    stubCli("1\n");
    const onSpawn = vi.fn();
    await runCliSession<TestEvent>(spec({ context: context({ onSpawn }) }) as never);
    expect(onSpawn).toHaveBeenCalledWith({ process_pid: 111, process_group_id: 111 });
  });

  it("returns cancelled without parsing when the run was aborted", async () => {
    stubCli("1\n2\n", { aborted: true });
    const parseResult = vi.fn();
    const out = await runCliSession<TestEvent>(spec({ parseResult }) as never);
    expect(out.status).toBe("cancelled");
    expect(parseResult).not.toHaveBeenCalled();
  });

  it("runs cleanup after parseResult on the normal path", async () => {
    stubCli("1\n");
    const order: string[] = [];
    await runCliSession<TestEvent>(
      spec({
        parseResult: () => {
          order.push("parse");
          return { status: "completed", output: "" };
        },
        cleanup: () => order.push("cleanup"),
      }) as never,
    );
    expect(order).toEqual(["parse", "cleanup"]);
  });

  it("runs cleanup on the abort path too", async () => {
    stubCli("1\n", { aborted: true });
    const cleanup = vi.fn();
    await runCliSession<TestEvent>(spec({ cleanup }) as never);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("warns once when the capture was truncated", async () => {
    stubCli("1\n", { truncated: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runCliSession<TestEvent>(spec() as never);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[TestRuntime]"));
  });
});
