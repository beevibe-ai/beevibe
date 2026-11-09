import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  runCliEventStream,
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


describe("runCliEventStream", () => {
  interface TestEvent {
    n: number;
  }

  function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      intent: "do the thing",
      system_prompt_append: "",
      workspace: { path: "/tmp/agent_x" },
      ...overrides,
    } as RuntimeContext;
  }

  /**
   * Stand in for `runCliProcess`: replays `stdout` through the caller's
   * `onLog` in the given chunks (so chunk boundaries are exercised), fires
   * `onSpawn`, then resolves with `result`.
   */
  function mockRunCli(
    chunks: string[],
    result: Partial<CliProcessResult> = {},
  ): { spy: ReturnType<typeof vi.spyOn>; seen: () => CliProcessOptions | undefined } {
    let lastOptions: CliProcessOptions | undefined;
    const spy = vi
      .spyOn(spawnModule, "runCliProcess")
      .mockImplementation(async (opts: CliProcessOptions) => {
        lastOptions = opts;
        opts.onSpawn?.({ pid: 4242, process_group_id: 4242 });
        for (const chunk of chunks) opts.onLog?.("stdout", chunk);
        return cliResult(result);
      });
    return { spy, seen: () => lastOptions };
  }

  const parseLine = (line: string): TestEvent | null => {
    const n = Number(line.trim());
    return Number.isFinite(n) && line.trim() ? { n } : null;
  };
  const noSteps = (): RuntimeStep[] => [];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects one parsed event per line, in arrival order", async () => {
    mockRunCli(["1\n2\n", "3\n"]);
    const { events } = await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx(),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: noSteps,
    });
    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("reassembles an event split across chunk boundaries", async () => {
    mockRunCli(["1", "2\n"]);
    const { events } = await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx(),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: noSteps,
    });
    expect(events).toEqual([{ n: 12 }]);
  });

  it("flushes a trailing line with no newline", async () => {
    mockRunCli(["1\n2"]);
    const { events } = await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx(),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: noSteps,
    });
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("skips lines the parser rejects without aborting the stream", async () => {
    mockRunCli(["1\nnoise\n\n2\n"]);
    const { events } = await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx(),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: noSteps,
    });
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("ignores stderr chunks", async () => {
    let lastOptions: CliProcessOptions | undefined;
    vi.spyOn(spawnModule, "runCliProcess").mockImplementation(
      async (opts: CliProcessOptions) => {
        lastOptions = opts;
        opts.onLog?.("stderr", "9\n");
        opts.onLog?.("stdout", "1\n");
        return cliResult();
      },
    );
    const { events } = await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx(),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: noSteps,
    });
    expect(lastOptions).toBeDefined();
    expect(events).toEqual([{ n: 1 }]);
  });

  it("fans each event's steps out to context.onStep in order", async () => {
    mockRunCli(["1\n2\n"]);
    const steps: RuntimeStep[] = [];
    await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx({ onStep: (s) => steps.push(s) }),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: (e) => [{ type: "text", text: String(e.n) } as RuntimeStep],
    });
    expect(steps.map((s) => (s as { text: string }).text)).toEqual(["1", "2"]);
  });

  it("does not call extractSteps when the context has no onStep", async () => {
    mockRunCli(["1\n"]);
    const extractSteps = vi.fn(() => [] as RuntimeStep[]);
    await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx(),
      runtimeTag: "Fake",
      parseLine,
      extractSteps,
    });
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("forwards argv, cwd, env, stdin and the abort signal to runCliProcess", async () => {
    const { seen } = mockRunCli([]);
    const controller = new AbortController();
    await runCliEventStream<TestEvent>({
      command: "fake",
      args: ["--flag"],
      cwd: "/tmp/ws",
      env: { FOO: "bar" },
      stdin: "piped intent",
      context: ctx({ abort_signal: controller.signal }),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: noSteps,
    });
    expect(seen()).toMatchObject({
      command: "fake",
      args: ["--flag"],
      cwd: "/tmp/ws",
      env: { FOO: "bar" },
      stdin: "piped intent",
      abortSignal: controller.signal,
    });
  });

  it("rewrites onSpawn's pid into the RuntimeContext shape", async () => {
    mockRunCli([]);
    const spawns: Array<{ process_pid: number; process_group_id: number }> = [];
    await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx({ onSpawn: (m) => spawns.push(m) }),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: noSteps,
    });
    expect(spawns).toEqual([{ process_pid: 4242, process_group_id: 4242 }]);
  });

  it("warns once, tagged, when stdout hit the capture cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunCli(["1\n"], { truncated: true });
    await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx(),
      runtimeTag: "FakeRuntime",
      parseLine,
      extractSteps: noSteps,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[FakeRuntime]");
  });

  it("returns the raw process result for the caller's own branching", async () => {
    mockRunCli([], { aborted: true, exitCode: null });
    const { result } = await runCliEventStream<TestEvent>({
      command: "fake",
      args: [],
      cwd: "/tmp",
      context: ctx(),
      runtimeTag: "Fake",
      parseLine,
      extractSteps: noSteps,
    });
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});
