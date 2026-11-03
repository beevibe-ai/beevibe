import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeContext, RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  bareCliExitMessage,
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  isBareCliExitMessage,
  runStreamingCli,
  selectCliOutput,
  transcriptLine,
  truncateInline,
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

describe("selectCliOutput", () => {
  const exitCode = 1;

  it("prefers the CLI's own failure message on failure", () => {
    expect(
      selectCliOutput({
        failed: true,
        failureMessage: "rate limited",
        assistantText: "partial answer",
        exitCode,
      }),
    ).toBe("rate limited");
  });

  it("falls through an empty failure message to the assistant text", () => {
    // The `||`-not-`??` contract: "" must not short-circuit.
    expect(
      selectCliOutput({
        failed: true,
        failureMessage: "",
        assistantText: "partial answer",
        exitCode,
      }),
    ).toBe("partial answer");
  });

  it("falls back to the bare exit message when a failure said nothing", () => {
    expect(
      selectCliOutput({ failed: true, assistantText: "", exitCode }),
    ).toBe(bareCliExitMessage(1));
  });

  it("prefers preferredOutput over assistant text on success", () => {
    expect(
      selectCliOutput({
        failed: false,
        assistantText: "streamed text",
        preferredOutput: "canonical final text",
        exitCode: 0,
      }),
    ).toBe("canonical final text");
  });

  it("falls through an empty preferredOutput to the assistant text", () => {
    expect(
      selectCliOutput({
        failed: false,
        assistantText: "streamed text",
        preferredOutput: "",
        exitCode: 0,
      }),
    ).toBe("streamed text");
  });

  it("uses the stand-in when a successful run produced no text at all", () => {
    expect(selectCliOutput({ failed: false, assistantText: "", exitCode: 0 })).toBe(
      "Session completed.",
    );
  });
});

describe("bareCliExitMessage / isBareCliExitMessage", () => {
  it("round-trips every exit-code shape", () => {
    for (const code of [0, 1, 137, -1, null]) {
      expect(isBareCliExitMessage(bareCliExitMessage(code))).toBe(true);
    }
  });

  it("does not match a message that merely contains one", () => {
    expect(isBareCliExitMessage("CLI exited with code 1: OOM killed")).toBe(false);
  });
});

describe("truncateInline", () => {
  it("folds newlines to spaces so one entry stays one transcript line", () => {
    expect(truncateInline("a\nb\nc")).toBe("a b c");
  });

  it("caps at 200 characters", () => {
    expect(truncateInline("x".repeat(500))).toHaveLength(200);
  });
});

describe("transcriptLine", () => {
  it("renders the tags downstream summarizers key off", () => {
    expect(transcriptLine.assistant("hi")).toBe("[assistant] hi\n");
    expect(transcriptLine.toolCall("Read")).toBe("[tool_call] Read\n");
    expect(transcriptLine.toolCall("shell", "ls -la")).toBe("[tool_call] shell ls -la\n");
    expect(transcriptLine.error("boom")).toBe("[error] boom\n");
  });

  it("omits an empty detail rather than leaving a trailing space", () => {
    expect(transcriptLine.toolResult("Read", "")).toBe("[tool_result from Read]\n");
    expect(transcriptLine.toolResult("Read", "ok")).toBe("[tool_result from Read] ok\n");
  });

  it("renders the anonymous form when the tool is unknown", () => {
    expect(transcriptLine.toolResult(undefined, "ignored")).toBe("[tool_result]\n");
  });
});

describe("runStreamingCli", () => {
  interface Evt {
    n: number;
  }
  const parseLine = (line: string): Evt | null =>
    line.trim() ? ({ n: Number(line) } as Evt) : null;

  function baseOpts(context: Partial<RuntimeContext> = {}) {
    return {
      runtimeTag: "TestRuntime",
      command: process.execPath,
      args: ["-e", "process.stdout.write('1\\n2\\n3')"],
      cwd: tmpdir(),
      env: { ...process.env },
      context: {
        intent: "",
        workspace: { path: tmpdir() },
        system_prompt_append: "",
        ...context,
      } as RuntimeContext,
      parseLine,
      extractSteps: (e: Evt): RuntimeStep[] => [
        { kind: "agent", description: String(e.n), timestamp: "t" },
      ],
    };
  }

  it("accumulates every parsed event, including a trailing partial line", async () => {
    // stdout above ends without a newline — the final "3" only survives
    // because runStreamingCli flushes the line reader after the process
    // settles.
    const { events, result } = await runStreamingCli(baseOpts());
    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(result.exitCode).toBe(0);
  });

  it("emits onStep for each event as it streams", async () => {
    const steps: RuntimeStep[] = [];
    await runStreamingCli(baseOpts({ onStep: (s) => steps.push(s) }));
    expect(steps.map((s) => s.description)).toEqual(["1", "2", "3"]);
  });

  it("forwards the spawned pid and process-group id to onSpawn", async () => {
    const spawns: Array<{ process_pid: number; process_group_id: number }> = [];
    const { result } = await runStreamingCli(
      baseOpts({ onSpawn: (meta) => spawns.push(meta) }),
    );
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.process_pid).toBe(result.pid);
  });

  it("skips unparseable lines instead of failing the run", async () => {
    const opts = baseOpts();
    opts.args = ["-e", "process.stdout.write('1\\nnoise\\n\\n2\\n')"];
    const { events } = await runStreamingCli(opts);
    expect(events).toEqual([{ n: 1 }, { n: NaN }, { n: 2 }]);
  });
});
