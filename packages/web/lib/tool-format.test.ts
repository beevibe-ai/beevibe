import { describe, expect, it } from "vitest";
import { formatTool } from "./tool-format";

describe("formatTool — session_search shape detection", () => {
  it("discover: query → 'Recalled past conversation' with quoted detail", () => {
    const display = formatTool(
      "mcp__beevibe__session_search",
      JSON.stringify({ query: "auth refactor" }),
    );
    expect(display.label).toBe("Recalled past conversation");
    expect(display.detail).toBe('"auth refactor"');
    expect(display.category).toBe("memory");
    expect(display.icon.displayName ?? "").toMatch(/History/);
  });

  it("scroll: session_id + around_message_id → 'Scrolled back'", () => {
    const display = formatTool(
      "session_search",
      JSON.stringify({ session_id: "sess_abc123def", around_message_id: "evt_xyz" }),
    );
    expect(display.label).toBe("Scrolled back");
    expect(display.detail).toBe("#abc123");
    expect(display.category).toBe("memory");
  });

  it("read: session_id alone → 'Re-read a past session'", () => {
    const display = formatTool(
      "session_search",
      JSON.stringify({ session_id: "sess_abc123def456" }),
    );
    expect(display.label).toBe("Re-read a past session");
    expect(display.detail).toBe("#abc123");
  });

  it("browse: empty args → 'Browsed recent sessions'", () => {
    const display = formatTool("session_search", JSON.stringify({}));
    expect(display.label).toBe("Browsed recent sessions");
    expect(display.detail).toBe("");
  });

  it("browse: completely unparseable content still falls back to browse label", () => {
    const display = formatTool("session_search", "not json at all");
    expect(display.label).toBe("Browsed recent sessions");
  });

  it("discover with whitespace-only query falls back to browse", () => {
    const display = formatTool(
      "session_search",
      JSON.stringify({ query: "   " }),
    );
    expect(display.label).toBe("Browsed recent sessions");
  });

  it("mcp__ prefix is stripped before name matching", () => {
    const display = formatTool(
      "mcp__beevibe__session_search",
      JSON.stringify({ query: "x" }),
    );
    expect(display.label).toBe("Recalled past conversation");
  });

  // tool_call rows from Claude Code's stream-json arrive as a stringified
  // function-call signature, NOT JSON. The discover/scroll/read inference
  // has to work against both.
  it("discover from function-call signature (Claude Code stream format)", () => {
    const display = formatTool(
      "mcp__beevibe__session_search",
      'mcp__beevibe__session_search(query="daemon timestamp", limit=5)',
    );
    expect(display.label).toBe("Recalled past conversation");
    expect(display.detail).toBe('"daemon timestamp"');
  });

  it("scroll from function-call signature", () => {
    const display = formatTool(
      "session_search",
      'session_search(session_id="sess_abc123def", around_message_id="evt_xyz", window=10)',
    );
    expect(display.label).toBe("Scrolled back");
    expect(display.detail).toBe("#abc123");
  });

  it("read from function-call signature", () => {
    const display = formatTool(
      "session_search",
      'session_search(session_id="sess_abc123def456")',
    );
    expect(display.label).toBe("Re-read a past session");
    expect(display.detail).toBe("#abc123");
  });

  it("browse when no recognised args appear in the call signature", () => {
    const display = formatTool(
      "session_search",
      "mcp__beevibe__session_search()",
    );
    expect(display.label).toBe("Browsed recent sessions");
  });

  it("handles single-quoted values in the call signature", () => {
    const display = formatTool(
      "session_search",
      "session_search(query='auth refactor', limit=3)",
    );
    expect(display.label).toBe("Recalled past conversation");
    expect(display.detail).toBe('"auth refactor"');
  });
});
