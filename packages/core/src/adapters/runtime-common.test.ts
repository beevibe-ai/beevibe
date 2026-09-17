import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeResult } from "../ports/runtime.js";
import {
  cancelledResult,
  createStdoutLineReader,
  finalizeCliResult,
  TranscriptBuilder,
  transcriptDetail,
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

describe("transcriptDetail", () => {
  it("returns empty for absent or empty input", () => {
    expect(transcriptDetail(undefined)).toBe("");
    expect(transcriptDetail(null)).toBe("");
    expect(transcriptDetail("")).toBe("");
  });

  it("flattens newlines to spaces so one entry stays one line", () => {
    expect(transcriptDetail("line one\nline two\nline three")).toBe(
      "line one line two line three",
    );
  });

  it("truncates to 200 chars", () => {
    expect(transcriptDetail("x".repeat(500))).toHaveLength(200);
  });

  it("truncates before flattening, matching the pre-extraction parsers", () => {
    // The old inline form was `.slice(0, 200).replace(/\n/g, " ")` in all
    // three adapters. Order matters: a newline past char 200 is cut, not
    // converted, so the result is still exactly 200 chars.
    const out = transcriptDetail("a".repeat(250) + "\ntail");
    expect(out).toBe("a".repeat(200));
    expect(out).toHaveLength(200);
  });
});

describe("TranscriptBuilder", () => {
  it("builds undefined when nothing was recorded", () => {
    expect(new TranscriptBuilder().build()).toBeUndefined();
  });

  it("formats an assistant line", () => {
    expect(new TranscriptBuilder().assistant("hello").build()).toBe("[assistant] hello\n");
  });

  it("formats a bare tool call", () => {
    expect(new TranscriptBuilder().toolCall("Read").build()).toBe("[tool_call] Read\n");
  });

  it("appends a detail to a tool call when one is given", () => {
    expect(new TranscriptBuilder().toolCall("shell", "pnpm build").build()).toBe(
      "[tool_call] shell pnpm build\n",
    );
  });

  it("keeps the trailing space for an empty tool-call detail", () => {
    // Codex emitted `[tool_call] shell \n` for a command-less execution
    // and its tests pin that exact string; passing "" must not silently
    // collapse to the bare form.
    expect(new TranscriptBuilder().toolCall("shell", "").build()).toBe("[tool_call] shell \n");
  });

  it("formats a tool result with a detail", () => {
    expect(new TranscriptBuilder().toolResult("Read", "ok").build()).toBe(
      "[tool_result from Read] ok\n",
    );
  });

  it("drops the detail segment when the detail is empty", () => {
    expect(new TranscriptBuilder().toolResult("Read", "").build()).toBe(
      "[tool_result from Read]\n",
    );
    expect(new TranscriptBuilder().toolResult("Read").build()).toBe("[tool_result from Read]\n");
  });

  it("falls back to an opaque tool result when the tool name is unknown", () => {
    expect(new TranscriptBuilder().toolResult(undefined, "ignored").build()).toBe(
      "[tool_result]\n",
    );
  });

  it("formats an error line", () => {
    expect(new TranscriptBuilder().error("boom").build()).toBe("[error] boom\n");
  });

  it("concatenates entries in call order", () => {
    const transcript = new TranscriptBuilder()
      .assistant("thinking")
      .toolCall("Read")
      .toolResult("Read", "file contents")
      .error("boom")
      .build();

    expect(transcript).toBe(
      "[assistant] thinking\n" +
        "[tool_call] Read\n" +
        "[tool_result from Read] file contents\n" +
        "[error] boom\n",
    );
  });

  it("is chainable", () => {
    const b = new TranscriptBuilder();
    expect(b.assistant("a")).toBe(b);
    expect(b.toolCall("t")).toBe(b);
    expect(b.toolResult("t", "d")).toBe(b);
    expect(b.error("e")).toBe(b);
  });
});
