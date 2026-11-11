import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 * `runCliSession` owns the ordering the three CLI runtimes used to
 * repeat inline, and the ordering is the part that can break quietly:
 * flush has to land before parsing, the abort check before parsing, and
 * `onSettled` after the parse that may still need the file it removes.
 * These drive it through a stubbed `runCliProcess` rather than a real
 * subprocess.
 */
describe("runCliSession", () => {
  interface Evt {
    n: number;
  }

  let runCliSpy: ReturnType<typeof vi.spyOn>;
  let lastOptions: CliProcessOptions | undefined;

  /** Stub `runCliProcess`: replay `chunks` over onLog, then settle. */
  function mockRunCli(chunks: string[], result: Partial<CliProcessResult> = {}): void {
    runCliSpy.mockImplementation(async (options) => {
      lastOptions = options;
      const settled = cliResult(result);
      if (settled.pid !== null) {
        options.onSpawn?.({
          pid: settled.pid,
          process_group_id: settled.process_group_id ?? settled.pid,
        });
      }
      for (const chunk of chunks) options.onLog?.("stdout", chunk);
      return settled;
    });
  }

  const ctx = (overrides: Partial<RuntimeContext> = {}): RuntimeContext => ({
    intent: "do a thing",
    workspace: { path: "/tmp/beevibe-run-cli-session" },
    system_prompt_append: "",
    ...overrides,
  });

  const parseLine = (line: string): Evt | null => {
    const n = Number(line.trim());
    return Number.isFinite(n) && line.trim() !== "" ? { n } : null;
  };

  function session(
    opts: Partial<Parameters<typeof runCliSession<Evt>>[0]> = {},
  ): Promise<RuntimeResult> {
    return runCliSession<Evt>({
      runtimeTag: "TestRuntime",
      context: ctx(),
      spawn: { command: "test-cli", args: [], cwd: "/tmp" },
      parseLine,
      extractSteps: () => [],
      parseResult: (events) => ({
        status: "completed",
        output: events.map((e) => e.n).join(","),
      }),
      ...opts,
    });
  }

  beforeEach(() => {
    lastOptions = undefined;
    runCliSpy = vi.spyOn(spawnModule, "runCliProcess");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses every event off the stream, across chunk boundaries", async () => {
    mockRunCli(["1\n2", "\n3\n"]);
    const result = await session();
    expect(result.output).toBe("1,2,3");
  });

  // A stream that ends without a trailing newline leaves its last line
  // in the buffer; without the flush it would be silently dropped.
  it("flushes a trailing partial line before parsing", async () => {
    mockRunCli(["1\n2\n3"]);
    const result = await session();
    expect(result.output).toBe("1,2,3");
  });

  it("skips lines the provider parser rejects", async () => {
    mockRunCli(["1\nnot an event\n\n2\n"]);
    expect((await session()).output).toBe("1,2");
  });

  it("forwards each event's steps to context.onStep as they arrive", async () => {
    mockRunCli(["1\n2\n"]);
    const steps: RuntimeStep[] = [];
    await session({
      context: ctx({ onStep: (s) => steps.push(s) }),
      extractSteps: (e) => [
        { kind: "agent_message", text: `step ${e.n}`, at: "2026-01-01T00:00:00.000Z" },
      ],
    });
    expect(steps.map((s) => s.text)).toEqual(["step 1", "step 2"]);
  });

  // `extractSteps` must not be called at all without an onStep sink —
  // the runtimes relied on that to skip the work entirely.
  it("does not extract steps when there is no onStep sink", async () => {
    mockRunCli(["1\n"]);
    const extractSteps = vi.fn(() => []);
    await session({ extractSteps });
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("threads abort_signal, onSpawn and the spawn options through", async () => {
    mockRunCli([]);
    const controller = new AbortController();
    const spawned: Array<{ process_pid: number }> = [];
    await session({
      context: ctx({ abort_signal: controller.signal, onSpawn: (m) => spawned.push(m) }),
      spawn: { command: "my-cli", args: ["--json"], cwd: "/tmp/ws", stdin: "the intent" },
    });
    expect(lastOptions?.command).toBe("my-cli");
    expect(lastOptions?.args).toEqual(["--json"]);
    expect(lastOptions?.cwd).toBe("/tmp/ws");
    expect(lastOptions?.stdin).toBe("the intent");
    expect(lastOptions?.abortSignal).toBe(controller.signal);
    expect(spawned).toEqual([{ process_pid: 4242, process_group_id: 4242 }]);
  });

  // An aborted session's stream is cut off mid-stride, so parsing it
  // would surface a half-transcript as a failure instead of a cancel.
  it("returns the cancelled result without parsing when aborted", async () => {
    mockRunCli(["1\n"], { aborted: true });
    const parseResult = vi.fn(() => ({ status: "completed" as const, output: "nope" }));
    const result = await session({ parseResult });
    expect(parseResult).not.toHaveBeenCalled();
    expect(result.status).toBe("cancelled");
    expect(result.process_pid).toBe(4242);
  });

  it("merges the process metadata into the parsed result", async () => {
    mockRunCli(["1\n"], { exitCode: 3, stderr: "boom" });
    const result = await session({
      parseResult: () => ({ status: "failed", output: "" }),
    });
    expect(result.exit_code).toBe(3);
    expect(result.stderr).toBe("boom");
    expect(result.process_pid).toBe(4242);
  });

  // Codex reads its --output-last-message file inside parseResult and
  // removes it in onSettled, so the order between the two is load-bearing.
  it("runs onSettled after parseResult on the normal path", async () => {
    mockRunCli(["1\n"]);
    const order: string[] = [];
    await session({
      parseResult: () => {
        order.push("parse");
        return { status: "completed", output: "" };
      },
      onSettled: () => order.push("settled"),
    });
    expect(order).toEqual(["parse", "settled"]);
  });

  it("still runs onSettled when aborted", async () => {
    mockRunCli(["1\n"], { aborted: true });
    const onSettled = vi.fn();
    await session({ onSettled });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("warns once when stdout was truncated, and still returns the result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunCli(["1\n"], { truncated: true });
    const result = await session();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[TestRuntime]");
    expect(result.output).toBe("1");
  });
});
