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

describe("runCliSession", () => {
  interface Evt {
    n: number;
  }

  function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      intent: "do a thing",
      workspace: { path: "/tmp/beevibe-runtime-common-test" },
      system_prompt_append: "",
      ...overrides,
    };
  }

  function spec(overrides: Partial<Parameters<typeof runCliSession<Evt>>[0]> = {}) {
    return {
      runtimeTag: "TestRuntime",
      command: "fake-cli",
      args: ["--json"],
      cwd: "/tmp/beevibe-runtime-common-test",
      env: {},
      context: ctx(),
      parseLine: (line: string): Evt | null =>
        line.trim() ? ({ n: Number(line) } as Evt) : null,
      extractSteps: (evt: Evt): RuntimeStep[] => [
        { kind: "agent", description: `step ${evt.n}`, timestamp: "t" },
      ],
      buildResult: (events: Evt[]): RuntimeResult => ({
        status: "completed",
        output: events.map((e) => e.n).join(","),
      }),
      ...overrides,
    };
  }

  function mockRunCli(result: Partial<CliProcessResult>, stdoutChunks: string[] = []) {
    return vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
      options.onSpawn?.({ pid: 4242, process_group_id: 4242 });
      for (const chunk of stdoutChunks) options.onLog?.("stdout", chunk);
      return cliResult(result);
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("folds the whole stream, including a final line with no trailing newline", async () => {
    // The flush() has to happen before buildResult or the last event is
    // silently dropped — the reason this sequence is shared, not copied.
    mockRunCli({}, ["1\n2\n", "3"]);
    const out = await runCliSession<Evt>(spec());
    expect(out.output).toBe("1,2,3");
  });

  it("streams each parsed event to context.onStep as it arrives", async () => {
    mockRunCli({}, ["7\n8\n"]);
    const steps: RuntimeStep[] = [];
    await runCliSession<Evt>(spec({ context: ctx({ onStep: (s) => steps.push(s) }) }));
    expect(steps.map((s) => s.description)).toEqual(["step 7", "step 8"]);
  });

  it("merges process metadata into the parsed result", async () => {
    mockRunCli({ exitCode: 0 }, ["1\n"]);
    const out = await runCliSession<Evt>(spec());
    expect(out.process_pid).toBe(4242);
    expect(out.process_group_id).toBe(4242);
    expect(out.exit_code).toBe(0);
  });

  it("reports an aborted run as cancelled without folding the events", async () => {
    // A cancelled session must not surface as a failure just because the
    // CLI exited non-zero on SIGTERM.
    mockRunCli({ aborted: true, exitCode: 143 }, ["1\n"]);
    const buildResult = vi.fn();
    const out = await runCliSession<Evt>(spec({ buildResult }));
    expect(out.status).toBe("cancelled");
    expect(buildResult).not.toHaveBeenCalled();
  });

  it("runs onSettled after buildResult, so a scratch file is still readable", async () => {
    mockRunCli({}, ["1\n"]);
    const order: string[] = [];
    await runCliSession<Evt>(
      spec({
        buildResult: () => {
          order.push("build");
          return { status: "completed", output: "" };
        },
        onSettled: () => order.push("settled"),
      }),
    );
    expect(order).toEqual(["build", "settled"]);
  });

  it("still runs onSettled on the aborted path", async () => {
    mockRunCli({ aborted: true }, []);
    const onSettled = vi.fn();
    await runCliSession<Evt>(spec({ onSettled }));
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("passes command, args, cwd, env and stdin straight through", async () => {
    let seen: CliProcessOptions | undefined;
    vi.spyOn(spawnModule, "runCliProcess").mockImplementation(async (options) => {
      seen = options;
      return cliResult();
    });
    await runCliSession<Evt>(
      spec({ command: "codex", args: ["exec"], env: { A: "1" }, stdin: "hello" }),
    );
    expect(seen?.command).toBe("codex");
    expect(seen?.args).toEqual(["exec"]);
    expect(seen?.env).toEqual({ A: "1" });
    expect(seen?.stdin).toBe("hello");
  });
});
