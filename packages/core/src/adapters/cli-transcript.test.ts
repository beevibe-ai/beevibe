import { describe, expect, it } from "vitest";
import { CliTranscript, DETAIL_MAX_CHARS, oneLineDetail } from "./cli-transcript.js";

describe("oneLineDetail", () => {
  it("collapses newlines to spaces so a detail stays on one line", () => {
    expect(oneLineDetail("line one\nline two\nline three")).toBe("line one line two line three");
  });

  it("truncates to DETAIL_MAX_CHARS", () => {
    expect(oneLineDetail("x".repeat(500))).toHaveLength(DETAIL_MAX_CHARS);
  });

  it("spends the budget on visible characters, not collapsed newlines", () => {
    // 300 newlines then 10 visible chars: truncating before collapsing would
    // return 200 spaces and lose the payload entirely.
    const out = oneLineDetail(`${"\n".repeat(300)}payload123`);
    expect(out).toHaveLength(DETAIL_MAX_CHARS);
    expect(out.trim()).toBe("");
  });

  it("leaves a short single-line detail untouched", () => {
    expect(oneLineDetail("ls -la")).toBe("ls -la");
  });
});

describe("CliTranscript", () => {
  it("reports undefined rather than an empty string when nothing was recorded", () => {
    expect(new CliTranscript().text()).toBeUndefined();
  });

  it("tags assistant prose", () => {
    const t = new CliTranscript();
    t.assistant("done");
    expect(t.text()).toBe("[assistant] done\n");
  });

  it("writes a bare tool_call when there is nothing to say at call time", () => {
    const t = new CliTranscript();
    t.toolCall("Read");
    expect(t.text()).toBe("[tool_call] Read\n");
  });

  it("appends a flattened detail to a tool_call that has one", () => {
    const t = new CliTranscript();
    t.toolCall("shell", "cd /tmp\nls");
    expect(t.text()).toBe("[tool_call] shell cd /tmp ls\n");
  });

  it("attributes a tool_result to its tool", () => {
    const t = new CliTranscript();
    t.toolResult("Bash", "exit 0");
    expect(t.text()).toBe("[tool_result from Bash] exit 0\n");
  });

  it("drops the attribution rather than claiming the wrong tool", () => {
    const t = new CliTranscript();
    t.toolResult(undefined, "some output");
    expect(t.text()).toBe("[tool_result] some output\n");
  });

  it("writes a bare [tool_result] when there is neither a tool nor output", () => {
    const t = new CliTranscript();
    t.toolResult(undefined);
    expect(t.text()).toBe("[tool_result]\n");
  });

  it("omits the detail slot on a tool_result that produced no output", () => {
    const t = new CliTranscript();
    t.toolResult("Write");
    expect(t.text()).toBe("[tool_result from Write]\n");
  });

  it("treats an empty-string detail as no detail", () => {
    const t = new CliTranscript();
    t.toolResult("Write", "");
    expect(t.text()).toBe("[tool_result from Write]\n");
  });

  it("tags a runtime-level error", () => {
    const t = new CliTranscript();
    t.error("rate limited");
    expect(t.text()).toBe("[error] rate limited\n");
  });

  it("preserves the order lines were recorded in", () => {
    const t = new CliTranscript();
    t.assistant("thinking");
    t.toolCall("Read");
    t.toolResult("Read", "file contents");
    t.assistant("done");
    expect(t.text()).toBe(
      "[assistant] thinking\n" +
        "[tool_call] Read\n" +
        "[tool_result from Read] file contents\n" +
        "[assistant] done\n",
    );
  });

  it("truncates a long tool result rather than letting it crowd the transcript", () => {
    const t = new CliTranscript();
    t.toolResult("Bash", "y".repeat(1000));
    expect(t.text()).toBe(`[tool_result from Bash] ${"y".repeat(DETAIL_MAX_CHARS)}\n`);
  });
});
