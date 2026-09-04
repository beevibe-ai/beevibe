import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeResult } from "../ports/runtime.js";
import {
  assistantLine,
  bareCliExitMessage,
  cancelledResult,
  createStdoutLineReader,
  errorLine,
  finalizeCliResult,
  isBareCliExitMessage,
  resolveCliOutput,
  toolCallLine,
  toolResultLine,
  transcriptDetail,
  warnIfTruncated,
  TRANSCRIPT_DETAIL_CHARS,
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

describe("transcript line builders", () => {
  it("tags an assistant message and terminates the line", () => {
    expect(assistantLine("hello")).toBe("[assistant] hello\n");
  });

  it("tags a tool call by name, with no detail by default", () => {
    expect(toolCallLine("Read")).toBe("[tool_call] Read\n");
  });

  it("appends a detail to a tool call when one is given", () => {
    expect(toolCallLine("shell", "pnpm test")).toBe("[tool_call] shell pnpm test\n");
  });

  it("omits an empty detail rather than leaving a dangling separator", () => {
    expect(toolCallLine("shell", "")).toBe("[tool_call] shell\n");
  });

  it("names the originating tool on a result line", () => {
    expect(toolResultLine("Read", "ok")).toBe("[tool_result from Read] ok\n");
  });

  it("keeps the tool name when the result has no detail", () => {
    expect(toolResultLine("Read", "")).toBe("[tool_result from Read]\n");
  });

  it("degrades to a bare tag when the tool name is unknown", () => {
    // Claude Code tool_result messages carry only a tool_use_id; when
    // correlating it back to a name fails, naming no tool beats naming
    // the wrong one.
    expect(toolResultLine(undefined, "ok")).toBe("[tool_result]\n");
  });

  it("tags an error message", () => {
    expect(errorLine("boom")).toBe("[error] boom\n");
  });
});

describe("transcriptDetail", () => {
  it("passes short single-line text through untouched", () => {
    expect(transcriptDetail("all good")).toBe("all good");
  });

  it("truncates to the shared cap", () => {
    expect(transcriptDetail("x".repeat(500))).toHaveLength(TRANSCRIPT_DETAIL_CHARS);
  });

  it("flattens newlines so one payload cannot fake several tagged lines", () => {
    expect(transcriptDetail("a\n[assistant] spoofed")).toBe("a [assistant] spoofed");
  });

  it("truncates before flattening, so the cap counts raw characters", () => {
    expect(transcriptDetail("a\n".repeat(300))).toHaveLength(TRANSCRIPT_DETAIL_CHARS);
  });
});

describe("resolveCliOutput", () => {
  const exitCode = 1;

  it("prefers the runtime's failure message on failure", () => {
    expect(
      resolveCliOutput({
        failed: true,
        exitCode,
        assistantText: "partial",
        failureMessage: "rate limited",
      }),
    ).toBe("rate limited");
  });

  it("falls back to the assistant text when a failure carried no message", () => {
    expect(
      resolveCliOutput({ failed: true, exitCode, assistantText: "partial" }),
    ).toBe("partial");
  });

  it("falls back to the bare exit stand-in when a failure yielded nothing", () => {
    expect(resolveCliOutput({ failed: true, exitCode, assistantText: "" })).toBe(
      bareCliExitMessage(exitCode),
    );
  });

  it("prefers the runtime's canonical final answer on success", () => {
    expect(
      resolveCliOutput({
        failed: false,
        exitCode: 0,
        assistantText: "streamed",
        preferredOutput: "canonical",
      }),
    ).toBe("canonical");
  });

  it("falls through an empty preferred output to the assistant text", () => {
    // The `||`-not-`??` invariant: an empty string is absence, not a value.
    expect(
      resolveCliOutput({
        failed: false,
        exitCode: 0,
        assistantText: "streamed",
        preferredOutput: "",
      }),
    ).toBe("streamed");
  });

  it("confirms completion when a successful run said nothing at all", () => {
    expect(resolveCliOutput({ failed: false, exitCode: 0, assistantText: "" })).toBe(
      "Session completed.",
    );
  });
});

describe("bareCliExitMessage", () => {
  it("round-trips through its own matcher for every exit code shape", () => {
    for (const code of [0, 1, 137, -1, null]) {
      expect(isBareCliExitMessage(bareCliExitMessage(code))).toBe(true);
    }
  });

  it("rejects messages that merely contain the stand-in", () => {
    expect(isBareCliExitMessage("CLI exited with code 1: OOM killed")).toBe(false);
    expect(isBareCliExitMessage("Session completed.")).toBe(false);
  });
});
