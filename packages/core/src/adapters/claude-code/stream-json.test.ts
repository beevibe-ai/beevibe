import { describe, expect, it } from "vitest";
import {
  extractStepEvents,
  parseClaudeStreamJson,
  parseStreamJsonLine,
  type StreamJsonMessage,
} from "./stream-json.js";

const firstStep = (msg: StreamJsonMessage) => extractStepEvents(msg)[0] ?? null;

describe("parseStreamJsonLine", () => {
  it("returns null for empty input", () => {
    expect(parseStreamJsonLine("")).toBeNull();
    expect(parseStreamJsonLine("   ")).toBeNull();
  });

  it("returns null for non-JSON lines", () => {
    expect(parseStreamJsonLine("not json")).toBeNull();
    expect(parseStreamJsonLine("[array]")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseStreamJsonLine("{unterminated")).toBeNull();
  });

  it("parses a valid message", () => {
    const msg = parseStreamJsonLine('{"type":"system","subtype":"init"}');
    expect(msg).toEqual({ type: "system", subtype: "init" });
  });
});

describe("extractStepEvents", () => {
  it("extracts file_path from tool_use input", () => {
    const step = firstStep({
      type: "tool_use",
      name: "Read",
      input: { file_path: "/src/main.ts" },
    });
    expect(step?.tool).toBe("Read");
    expect(step?.description).toBe("/src/main.ts");
    expect(step?.timestamp).toBeTruthy();
  });

  it("extracts command from Bash tool input", () => {
    const step = firstStep({
      type: "tool_use",
      name: "Bash",
      input: { command: "ls -la /tmp" },
    });
    expect(step?.tool).toBe("Bash");
    expect(step?.description).toBe("ls -la /tmp");
  });

  it("extracts query from Grep input", () => {
    const step = firstStep({
      type: "tool_use",
      name: "Grep",
      input: { query: "needle" },
    });
    expect(step?.description).toBe("needle");
  });

  it("returns null for non-tool messages", () => {
    expect(firstStep({ type: "system" } as StreamJsonMessage)).toBeNull();
    expect(firstStep({ type: "result" } as StreamJsonMessage)).toBeNull();
  });

  it("extracts from content_block_start with tool_use block", () => {
    const step = firstStep({
      type: "content_block_start",
      content_block: { type: "tool_use", name: "Write", input: { file_path: "/tmp/x" } },
    });
    expect(step?.tool).toBe("Write");
    expect(step?.description).toBe("/tmp/x");
  });

  it("falls back to JSON.stringify for unknown multi-key input shapes", () => {
    const step = firstStep({
      type: "tool_use",
      name: "Custom",
      input: { foo: "bar", baz: "qux" },
    });
    expect(step?.description).toContain("foo");
  });

  it("returns the lone string value for single-key input shapes", () => {
    const step = firstStep({
      type: "tool_use",
      name: "Custom",
      input: { something: "the value" },
    });
    expect(step?.description).toBe("the value");
  });

  it("emits a tool_result step with the result content", () => {
    const step = firstStep({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "file contents line 1\nline 2",
    });
    expect(step?.kind).toBe("tool_result");
    expect(step?.description).toBe("file contents line 1 line 2");
  });

  it("tags tool_result with [error] prefix when is_error is true", () => {
    const step = firstStep({
      type: "tool_result",
      tool_use_id: "tu_2",
      is_error: true,
      content: "task_id required",
    });
    expect(step?.kind).toBe("tool_result");
    expect(step?.description).toBe("[error] task_id required");
  });
});

describe("parseClaudeStreamJson", () => {
  const sampleStream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "thinking about this..." },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/src/a.ts" } },
        ],
      },
    }),
    JSON.stringify({ type: "tool_result", tool_use_id: "tu_1", content: "file contents line 1\nline 2" }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the final answer: ok" }],
      },
    }),
    JSON.stringify({
      type: "result",
      session_id: "cli_sess_abc",
      total_cost_usd: 0.0123,
      model: "claude-opus-4-7",
      usage: { input_tokens: 1500, output_tokens: 200 },
    }),
  ].join("\n");

  it("extracts final assistant text as output", () => {
    const result = parseClaudeStreamJson(sampleStream, 0);
    expect(result.output).toBe("Here is the final answer: ok");
  });

  it("extracts cli_session_id from result message", () => {
    const result = parseClaudeStreamJson(sampleStream, 0);
    expect(result.cli_session_id).toBe("cli_sess_abc");
  });

  it("extracts usage with cost, tokens, and model (M9.8: cache fields default to 0 when absent)", () => {
    const result = parseClaudeStreamJson(sampleStream, 0);
    expect(result.usage).toEqual({
      input_tokens: 1500,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd: 0.0123,
      model: "claude-opus-4-7",
    });
  });

  it("M9.8: extracts cache_creation_input_tokens and cache_read_input_tokens when present", () => {
    // Realistic cached-prompt shape: small new input + small cache write +
    // big cache read. The three counters are DISJOINT slices of the same
    // prompt; total = input + cache_creation + cache_read.
    const stream = JSON.stringify({
      type: "result",
      session_id: "cli_sess_xyz",
      total_cost_usd: 0.05,
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 100,
        output_tokens: 412,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 9700,
      },
    });
    const result = parseClaudeStreamJson(stream, 0);
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 412,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 9700,
      cost_usd: 0.05,
      model: "claude-opus-4-7",
    });
    // Cache hit ratio = cache_read / (input + cache_creation + cache_read).
    // 9700 / (100 + 200 + 9700) = 9700 / 10000 = 97% — high cache utilization.
    const u = result.usage!;
    const total = u.input_tokens! + u.cache_creation_input_tokens! + u.cache_read_input_tokens!;
    const ratio = u.cache_read_input_tokens! / total;
    expect(ratio).toBeGreaterThan(0.9);
  });

  it("correlates tool_result with its tool_use via tool_use_id", () => {
    const result = parseClaudeStreamJson(sampleStream, 0);
    expect(result.transcript).toContain("[tool_result from Read]");
    expect(result.transcript).toContain("file contents line 1");
  });

  it("sets status=completed on exit 0", () => {
    const result = parseClaudeStreamJson(sampleStream, 0);
    expect(result.status).toBe("completed");
  });

  it("sets status=failed on non-zero exit", () => {
    const result = parseClaudeStreamJson(sampleStream, 1);
    expect(result.status).toBe("failed");
  });

  it("returns default output when stdout is empty + exit 0", () => {
    const result = parseClaudeStreamJson("", 0);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Session completed.");
    expect(result.cli_session_id).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  it("returns diagnostic output when stdout is empty + non-zero exit", () => {
    const result = parseClaudeStreamJson("", 2);
    expect(result.status).toBe("failed");
    expect(result.output).toMatch(/CLI exited with code 2/);
  });

  it("falls back to opaque [tool_result] when tool_use_id is missing", () => {
    const stream = JSON.stringify({ type: "tool_result", content: "stuff" });
    const result = parseClaudeStreamJson(stream, 0);
    expect(result.transcript).toContain("[tool_result]");
    expect(result.transcript).not.toContain("from");
  });
});
