import { describe, expect, it } from "vitest";
import {
  bareCliExitMessage,
  extractStepEvents,
  isBareCliExitMessage,
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

  it("surfaces the new agent's name for the create_subordinate_agent shape", () => {
    // `name` isn't in PREFERRED_INPUT_FIELDS, so this shape needs the
    // name+persona special case to avoid rendering as raw JSON.
    const step = firstStep({
      type: "tool_use",
      name: "create_subordinate_agent",
      input: { name: "Backend IC", persona: "I write Go services.", hierarchy_level: "ic" },
    });
    expect(step?.description).toBe("Backend IC");
  });

  it("ignores the name+persona case when persona is absent", () => {
    const step = firstStep({
      type: "tool_use",
      name: "SomeTool",
      input: { name: "Backend IC", other: 1 },
    });
    expect(step?.description).toContain("Backend IC");
    expect(step?.description).toContain("other");
  });

  it("emits one step per block for an assistant message with text + tool_use", () => {
    const steps = extractStepEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look at that file." },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/src/a.ts" } },
        ],
      },
    });

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      kind: "agent",
      description: "Let me look at that file.",
    });
    expect(steps[1]).toMatchObject({
      kind: "tool_call",
      tool: "Read",
      description: "/src/a.ts",
    });
  });

  it("drops whitespace-only assistant text blocks", () => {
    const steps = extractStepEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "   \n  " },
          { type: "text", text: "real content" },
        ],
      },
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]?.description).toBe("real content");
  });

  it("skips thinking blocks in an assistant message", () => {
    const steps = extractStepEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
      },
    });

    expect(steps).toEqual([]);
  });

  it("labels an assistant tool_use block with no name as 'unknown'", () => {
    const steps = extractStepEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", input: { command: "ls" } }],
      },
    });

    expect(steps[0]).toMatchObject({ kind: "tool_call", tool: "unknown", description: "ls" });
  });

  it("returns no steps for an assistant message whose content is a bare string", () => {
    // The step feed only understands the block form; the string form is
    // still picked up by parseClaudeStreamJson for the transcript.
    expect(
      extractStepEvents({
        type: "assistant",
        message: { role: "assistant", content: "plain" },
      }),
    ).toEqual([]);
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

  it("handles a string-valued assistant message content", () => {
    // Older CLI builds emit `content` as a bare string rather than blocks.
    const stream = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "plain string answer" },
    });
    const result = parseClaudeStreamJson(stream, 0);
    expect(result.output).toBe("plain string answer");
    expect(result.transcript).toContain("[assistant] plain string answer");
  });

  it("names the tool but omits the payload when a tool_result has no string content", () => {
    // The tool_use_id → name map is built from assistant content blocks,
    // so the tool_use has to arrive that way for the name to resolve.
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_9", name: "Grep", input: { pattern: "x" } }],
        },
      }),
      JSON.stringify({ type: "tool_result", tool_use_id: "tu_9", content: { rows: 3 } }),
    ].join("\n");
    const result = parseClaudeStreamJson(stream, 0);
    expect(result.transcript).toContain("[tool_result from Grep]");
    expect(result.transcript).not.toContain("rows");
  });

  it("records a top-level tool_use with no name as 'unknown'", () => {
    const stream = JSON.stringify({ type: "tool_use", input: { file_path: "/a" } });
    const result = parseClaudeStreamJson(stream, 0);
    expect(result.transcript).toContain("[tool_call] unknown");
  });

  it("keeps thinking blocks out of the transcript", () => {
    const stream = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning", signature: "sig" },
          { type: "text", text: "visible answer" },
        ],
      },
    });
    const result = parseClaudeStreamJson(stream, 0);
    expect(result.transcript).not.toContain("secret reasoning");
    expect(result.output).toBe("visible answer");
  });
});

describe("isBareCliExitMessage", () => {
  it("matches the strings bareCliExitMessage produces", () => {
    for (const code of [0, 1, 2, 137, -1, null]) {
      expect(isBareCliExitMessage(bareCliExitMessage(code))).toBe(true);
    }
  });

  it("rejects a real diagnostic that merely mentions an exit code", () => {
    // The point of the predicate is to tell "we have nothing useful" apart
    // from "we have a real error", so near-misses must not match.
    expect(isBareCliExitMessage("CLI exited with code 1: OOM killed")).toBe(false);
    expect(isBareCliExitMessage("claude: CLI exited with code 1")).toBe(false);
    expect(isBareCliExitMessage("CLI exited with code")).toBe(false);
    expect(isBareCliExitMessage("CLI exited with code abc")).toBe(false);
    expect(isBareCliExitMessage("")).toBe(false);
    expect(isBareCliExitMessage("Session completed.")).toBe(false);
  });

  it("flags the output parseClaudeStreamJson emits for an empty failed run", () => {
    const result = parseClaudeStreamJson("", 2);
    expect(isBareCliExitMessage(result.output)).toBe(true);
  });

  it("does not flag the output of a run that produced real text", () => {
    const stream = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    expect(isBareCliExitMessage(parseClaudeStreamJson(stream, 1).output)).toBe(
      false,
    );
  });
});
