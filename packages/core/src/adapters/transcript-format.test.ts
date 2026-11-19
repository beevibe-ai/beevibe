import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_DETAIL_LIMIT,
  assistantLine,
  errorLine,
  summarizeDetail,
  toolCallLine,
  toolResultLine,
} from "./transcript-format.js";

describe("summarizeDetail", () => {
  it("truncates to the detail limit", () => {
    expect(summarizeDetail("x".repeat(500))).toHaveLength(TRANSCRIPT_DETAIL_LIMIT);
  });

  it("folds newlines to spaces so one result stays one line", () => {
    expect(summarizeDetail("a\nb\nc")).toBe("a b c");
  });

  it("folds newlines that survive the truncation, not ones past it", () => {
    // Truncate-then-fold: the fold only ever sees the kept prefix.
    const out = summarizeDetail("a\n" + "x".repeat(TRANSCRIPT_DETAIL_LIMIT));
    expect(out).toHaveLength(TRANSCRIPT_DETAIL_LIMIT);
    expect(out.startsWith("a x")).toBe(true);
    expect(out).not.toContain("\n");
  });

  it("passes short single-line text through unchanged", () => {
    expect(summarizeDetail("ok")).toBe("ok");
  });

  it("returns empty for empty input", () => {
    expect(summarizeDetail("")).toBe("");
  });
});

describe("assistantLine", () => {
  it("tags and newline-terminates the text", () => {
    expect(assistantLine("hello")).toBe("[assistant] hello\n");
  });
});

describe("toolCallLine", () => {
  it("renders the bare tool name when there is no argument summary", () => {
    expect(toolCallLine("Read")).toBe("[tool_call] Read\n");
  });

  it("appends an argument summary when given one", () => {
    expect(toolCallLine("shell", "ls -la")).toBe("[tool_call] shell ls -la\n");
  });

  it("does not leave a dangling space for an empty argument summary", () => {
    expect(toolCallLine("shell", "")).toBe("[tool_call] shell\n");
  });
});

describe("toolResultLine", () => {
  it("attributes the result to its tool", () => {
    expect(toolResultLine("Read", "file contents")).toBe(
      "[tool_result from Read] file contents\n",
    );
  });

  it("omits the detail suffix when the result was empty", () => {
    expect(toolResultLine("Read", "")).toBe("[tool_result from Read]\n");
  });

  it("degrades to a bare tag rather than inventing an attribution", () => {
    // Claude Code can emit a tool_result whose tool_use_id never matched a
    // tool_use block, so the tool name is genuinely unknown.
    expect(toolResultLine(undefined, "orphaned result")).toBe("[tool_result]\n");
  });
});

describe("errorLine", () => {
  it("tags and newline-terminates the message", () => {
    expect(errorLine("budget exceeded")).toBe("[error] budget exceeded\n");
  });
});
