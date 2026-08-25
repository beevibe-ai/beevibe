import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessOptions, CliProcessResult } from "./claude-code/spawn.js";
import * as spawnModule from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  assistantLine,
  cancelledResult,
  createStdoutLineReader,
  errorLine,
  finalizeCliResult,
  inlineSnippet,
  runCliStream,
  toolCallLine,
  toolResultLine,
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

describe("runCliStream", () => {
  interface Evt {
    n: number;
  }

  function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      intent: "do a thing",
      workspace: { path: "/tmp/beevibe-stream-test" },
      system_prompt_append: "",
      ...overrides,
    };
  }

  function stream(
    context: RuntimeContext,
    opts: { extractSteps?: (e: Evt) => RuntimeStep[] } = {},
  ) {
    return runCliStream<Evt>({
      runtimeTag: "TestRuntime",
      command: "fake-cli",
      args: ["--json"],
      cwd: context.workspace.path,
      context,
      parseLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return null;
        return JSON.parse(trimmed) as Evt;
      },
      extractSteps: opts.extractSteps ?? (() => []),
    });
  }

  /** Mock `runCliProcess`, replaying `stdout` through `onLog` in `chunks`. */
  function mockCli(chunks: string[], overrides: Partial<CliProcessResult> = {}) {
    let seen: CliProcessOptions | undefined;
    const spy = vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
      seen = options;
      const result = cliResult(overrides);
      if (result.pid !== null) {
        options.onSpawn?.({
          pid: result.pid,
          process_group_id: result.process_group_id ?? result.pid,
        });
      }
      for (const chunk of chunks) options.onLog?.("stdout", chunk);
      return result;
    });
    return { spy, options: () => seen };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects parsed events in arrival order and skips unparseable lines", async () => {
    mockCli(['{"n":1}\nnot json\n{"n":2}\n']);
    const { events, result } = await stream(ctx());
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
    expect(result.exitCode).toBe(0);
  });

  it("reassembles an event split across stdout chunks", async () => {
    mockCli(['{"n', '":7}\n']);
    const { events } = await stream(ctx());
    expect(events).toEqual([{ n: 7 }]);
  });

  it("flushes a trailing line the stream never terminated with a newline", async () => {
    mockCli(['{"n":1}\n{"n":2}']);
    const { events } = await stream(ctx());
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("forwards each event's steps to context.onStep", async () => {
    mockCli(['{"n":1}\n{"n":2}\n']);
    const steps: RuntimeStep[] = [];
    await stream(ctx({ onStep: (s) => steps.push(s) }), {
      extractSteps: (e) => [{ kind: "agent", description: `step ${e.n}`, timestamp: "t" }],
    });
    expect(steps.map((s) => s.description)).toEqual(["step 1", "step 2"]);
  });

  it("skips step extraction entirely when the caller wants no live steps", async () => {
    mockCli(['{"n":1}\n']);
    const extractSteps = vi.fn(() => []);
    const { events } = await stream(ctx(), { extractSteps });
    expect(events).toHaveLength(1);
    expect(extractSteps).not.toHaveBeenCalled();
  });

  it("relays spawn metadata through context.onSpawn", async () => {
    mockCli([]);
    const onSpawn = vi.fn();
    await stream(ctx({ onSpawn }));
    expect(onSpawn).toHaveBeenCalledWith({ process_pid: 4242, process_group_id: 4242 });
  });

  it("passes command, args, cwd, env, stdin and the abort signal to the spawner", async () => {
    const { options } = mockCli([]);
    const controller = new AbortController();
    await runCliStream<Evt>({
      runtimeTag: "TestRuntime",
      command: "fake-cli",
      args: ["--json"],
      cwd: "/ws",
      env: { FOO: "bar" },
      stdin: "the intent",
      context: ctx({ abort_signal: controller.signal }),
      parseLine: () => null,
      extractSteps: () => [],
    });
    expect(options()).toMatchObject({
      command: "fake-cli",
      args: ["--json"],
      cwd: "/ws",
      env: { FOO: "bar" },
      stdin: "the intent",
      abortSignal: controller.signal,
    });
  });

  it("warns with the runtime tag when stdout was capped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCli(['{"n":1}\n'], { truncated: true });
    await stream(ctx());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[TestRuntime]"));
  });
});

describe("transcript line builders", () => {
  it("truncates and flattens a payload onto one line", () => {
    expect(inlineSnippet("line one\nline two")).toBe("line one line two");
    expect(inlineSnippet("x".repeat(500))).toHaveLength(200);
    expect(inlineSnippet("abcdef", 3)).toBe("abc");
  });

  it("tags assistant text", () => {
    expect(assistantLine("hello")).toBe("[assistant] hello\n");
  });

  it("renders a tool call with and without an argument summary", () => {
    expect(toolCallLine("Read")).toBe("[tool_call] Read\n");
    expect(toolCallLine("shell", "pnpm test")).toBe("[tool_call] shell pnpm test\n");
    // An empty detail collapses to the bare form rather than leaving a
    // trailing space.
    expect(toolCallLine("shell", "")).toBe("[tool_call] shell\n");
  });

  it("attributes a tool result to its tool", () => {
    expect(toolResultLine("Read", "file contents")).toBe("[tool_result from Read] file contents\n");
    expect(toolResultLine("Read")).toBe("[tool_result from Read]\n");
    expect(toolResultLine("Read", "")).toBe("[tool_result from Read]\n");
  });

  it("degrades to the opaque form — dropping detail — when the tool is unknown", () => {
    expect(toolResultLine(undefined)).toBe("[tool_result]\n");
    expect(toolResultLine(undefined, "orphaned payload")).toBe("[tool_result]\n");
  });

  it("tags a run-level error", () => {
    expect(errorLine("rate limited")).toBe("[error] rate limited\n");
  });
});
