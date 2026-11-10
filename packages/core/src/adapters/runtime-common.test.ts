import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProcessResult } from "./claude-code/spawn.js";
import type { RuntimeResult, RuntimeStep } from "../ports/runtime.js";
import {
  SESSION_COMPLETED_OUTPUT,
  TRANSCRIPT_SNIPPET_MAX,
  cancelledResult,
  createCliEventCollector,
  createStdoutLineReader,
  createTranscript,
  finalizeCliResult,
  oneLineSnippet,
  resolveCliOutput,
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

describe("oneLineSnippet", () => {
  it("flattens newlines so the text stays on one transcript line", () => {
    expect(oneLineSnippet("line one\nline two")).toBe("line one line two");
  });

  it("truncates to the shared cap, then flattens", () => {
    const text = "a".repeat(TRANSCRIPT_SNIPPET_MAX) + "\nTAIL";
    const out = oneLineSnippet(text);
    expect(out).toHaveLength(TRANSCRIPT_SNIPPET_MAX);
    expect(out).not.toContain("TAIL");
  });

  it("honours an explicit max", () => {
    expect(oneLineSnippet("abcdef", 3)).toBe("abc");
  });

  it("collapses undefined / null / empty to an empty string", () => {
    expect(oneLineSnippet(undefined)).toBe("");
    expect(oneLineSnippet(null)).toBe("");
    expect(oneLineSnippet("")).toBe("");
  });
});

describe("resolveCliOutput", () => {
  it("takes the first non-empty candidate", () => {
    expect(
      resolveCliOutput({ failed: false, exitCode: 0, candidates: ["first", "second"] }),
    ).toBe("first");
  });

  it("falls through empty and undefined candidates rather than short-circuiting", () => {
    expect(
      resolveCliOutput({ failed: false, exitCode: 0, candidates: [undefined, "", "third"] }),
    ).toBe("third");
  });

  it("falls back to the shared completion string on success", () => {
    expect(resolveCliOutput({ failed: false, exitCode: 0, candidates: [] })).toBe(
      SESSION_COMPLETED_OUTPUT,
    );
  });

  it("falls back to the bare exit message on failure", () => {
    expect(resolveCliOutput({ failed: true, exitCode: 2, candidates: [""] })).toBe(
      "CLI exited with code 2",
    );
  });

  it("renders a null exit code in the bare exit message", () => {
    expect(resolveCliOutput({ failed: true, exitCode: null, candidates: [] })).toBe(
      "CLI exited with code null",
    );
  });
});

describe("createTranscript", () => {
  it("returns undefined when nothing was pushed", () => {
    expect(createTranscript().value()).toBeUndefined();
  });

  it("tags each line and terminates it with a newline", () => {
    const t = createTranscript();
    t.assistant("hello");
    t.toolCall("Read");
    t.toolResult("Read", "file contents");
    t.error("boom");
    expect(t.value()).toBe(
      "[assistant] hello\n[tool_call] Read\n[tool_result from Read] file contents\n[error] boom\n",
    );
  });

  it("appends a detail to a tool_call when one is given", () => {
    const t = createTranscript();
    t.toolCall("shell", "pnpm build");
    expect(t.value()).toBe("[tool_call] shell pnpm build\n");
  });

  it("omits the detail from a tool_result when it is empty", () => {
    const t = createTranscript();
    t.toolResult("Bash", "");
    t.toolResult("Grep");
    expect(t.value()).toBe("[tool_result from Bash]\n[tool_result from Grep]\n");
  });

  it("degrades to a bare [tool_result] when the tool is unknown", () => {
    const t = createTranscript();
    t.toolResult(undefined, "orphaned result");
    expect(t.value()).toBe("[tool_result]\n");
  });
});

describe("createCliEventCollector", () => {
  const parse = (line: string): { n: number } | null => {
    const n = Number(line.trim());
    return Number.isFinite(n) && line.trim() ? { n } : null;
  };

  it("collects parsed events in stream order and skips unparseable lines", () => {
    const c = createCliEventCollector({ parse, extractSteps: () => [] });
    c.onLog("stdout", "1\nnot-a-number\n2\n");
    expect(c.events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("reassembles an event split across chunks and ignores stderr", () => {
    const c = createCliEventCollector({ parse, extractSteps: () => [] });
    c.onLog("stdout", "1");
    c.onLog("stderr", "99\n");
    c.onLog("stdout", "2\n");
    expect(c.events).toEqual([{ n: 12 }]);
  });

  it("flush picks up a final line with no trailing newline", () => {
    const c = createCliEventCollector({ parse, extractSteps: () => [] });
    c.onLog("stdout", "7");
    expect(c.events).toEqual([]);
    c.flush();
    expect(c.events).toEqual([{ n: 7 }]);
  });

  it("fans derived steps out to onStep in order", () => {
    const steps: RuntimeStep[] = [];
    const c = createCliEventCollector({
      parse,
      extractSteps: (e) => [
        { kind: "agent", description: `a${e.n}`, timestamp: "t" },
        { kind: "agent", description: `b${e.n}`, timestamp: "t" },
      ],
      onStep: (s) => steps.push(s),
    });
    c.onLog("stdout", "1\n");
    expect(steps.map((s) => s.description)).toEqual(["a1", "b1"]);
  });

  it("still collects events when no onStep is wired", () => {
    const extractSteps = vi.fn(() => []);
    const c = createCliEventCollector({ parse, extractSteps });
    c.onLog("stdout", "3\n");
    expect(c.events).toEqual([{ n: 3 }]);
    // No consumer for the steps, so the extractor is never invoked.
    expect(extractSteps).not.toHaveBeenCalled();
  });
});
