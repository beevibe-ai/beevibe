import type { RuntimeResult, RuntimeStep } from "../../ports/runtime.js";

/**
 * Parser for Claude Code's `--output-format stream-json` output. Each line
 * is a JSON message with a `type` discriminator.
 */

export const STREAM_TYPE = {
  System: "system",
  Assistant: "assistant",
  ToolUse: "tool_use",
  ToolResult: "tool_result",
  Result: "result",
  ContentBlockStart: "content_block_start",
} as const;

export const BLOCK_TYPE = {
  Text: "text",
  ToolUse: "tool_use",
} as const;

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}

export interface StreamJsonMessage {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  session_id?: string;
  cost_usd?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  model?: string;
  result?: string;
  content_block?: ContentBlock;
}

export function parseStreamJsonLine(line: string): StreamJsonMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as StreamJsonMessage;
  } catch {
    return null;
  }
}

export function extractStepEvents(msg: StreamJsonMessage): RuntimeStep[] {
  const now = new Date().toISOString();

  if (msg.type === STREAM_TYPE.ToolUse || msg.subtype === STREAM_TYPE.ToolUse) {
    return [
      {
        kind: "tool_call",
        tool: msg.name ?? "unknown",
        description: describeToolInput(msg.input ?? {}),
        timestamp: now,
      },
    ];
  }

  if (msg.type === STREAM_TYPE.ContentBlockStart && msg.content_block?.type === BLOCK_TYPE.ToolUse) {
    const block = msg.content_block;
    return [
      {
        kind: "tool_call",
        tool: block.name ?? "unknown",
        description: describeToolInput((block.input ?? {}) as Record<string, unknown>),
        timestamp: now,
      },
    ];
  }

  // Assistant text + inline tool_use blocks. Stream-json emits one
  // `assistant` message per LLM output between tool calls; its content
  // is one or more blocks. We surface text blocks as `agent` steps so
  // the chat UI can show the response being written, and tool_use
  // blocks (when they appear here rather than as standalone messages)
  // as `tool_call` steps.
  if (msg.type === STREAM_TYPE.Assistant && msg.message && Array.isArray(msg.message.content)) {
    const out: RuntimeStep[] = [];
    for (const block of msg.message.content) {
      if (block.type === BLOCK_TYPE.Text && typeof block.text === "string" && block.text.trim().length > 0) {
        out.push({
          kind: "agent",
          description: block.text,
          timestamp: now,
        });
      } else if (block.type === BLOCK_TYPE.ToolUse) {
        out.push({
          kind: "tool_call",
          tool: block.name ?? "unknown",
          description: describeToolInput((block.input ?? {}) as Record<string, unknown>),
          timestamp: now,
        });
      }
    }
    return out;
  }

  return [];
}

/** @deprecated Use `extractStepEvents` (returns 0+ steps per message). */
export function extractStepEvent(msg: StreamJsonMessage): RuntimeStep | null {
  const steps = extractStepEvents(msg);
  return steps[0] ?? null;
}

function describeToolInput(input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command.slice(0, 100);
  if (typeof input.query === "string") return input.query.slice(0, 100);
  return JSON.stringify(input).slice(0, 100);
}

/**
 * Build RuntimeResult from an array of pre-parsed messages.
 *
 * Does NOT set `status: "cancelled"` — that's the caller's job when an
 * abort caused the exit. This function only distinguishes "completed"
 * (exit 0) from "failed" (non-zero).
 *
 * Callers that parsed messages during streaming (e.g. ClaudeCodeRuntime
 * via a line buffer) pass `messages` directly. Callers that only have
 * the accumulated stdout use `parseClaudeStreamJson` instead.
 */
export function parseClaudeMessages(
  messages: StreamJsonMessage[],
  exitCode: number | null,
): Omit<RuntimeResult, "process_pid" | "process_group_id"> {
  // Correlate tool_use_id → tool name so tool_result transcript entries
  // can show which tool they came from. Without this, [tool_result] would
  // be opaque and misleading to downstream LLM consumers.
  const toolUseNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type === STREAM_TYPE.Assistant && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === BLOCK_TYPE.ToolUse && block.id) {
          toolUseNames.set(block.id, block.name ?? "unknown");
        }
      }
    }
  }

  const transcriptParts: string[] = [];
  let output = "";
  let sessionId: string | undefined;
  let costUsd: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;

  for (const msg of messages) {
    if (msg.type === STREAM_TYPE.Assistant && msg.message) {
      const content = msg.message.content;
      if (typeof content === "string") {
        transcriptParts.push(`[assistant] ${content}\n`);
        output = content;
      } else if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === BLOCK_TYPE.Text && typeof block.text === "string") {
            transcriptParts.push(`[assistant] ${block.text}\n`);
            texts.push(block.text);
          } else if (block.type === BLOCK_TYPE.ToolUse) {
            transcriptParts.push(`[tool_call] ${block.name ?? "unknown"}\n`);
          }
          // Skip thinking blocks + signatures — they bloat the transcript.
        }
        if (texts.length > 0) output = texts.join("\n");
      }
    } else if (msg.type === STREAM_TYPE.ToolUse) {
      transcriptParts.push(`[tool_call] ${msg.name ?? "unknown"}\n`);
    } else if (msg.type === STREAM_TYPE.ToolResult) {
      const toolName = msg.tool_use_id ? toolUseNames.get(msg.tool_use_id) : undefined;
      const resultContent =
        typeof msg.content === "string" ? msg.content.slice(0, 200).replace(/\n/g, " ") : "";
      if (toolName) {
        transcriptParts.push(
          resultContent
            ? `[tool_result from ${toolName}] ${resultContent}\n`
            : `[tool_result from ${toolName}]\n`,
        );
      } else {
        transcriptParts.push("[tool_result]\n");
      }
    } else if (msg.type === STREAM_TYPE.Result) {
      sessionId = msg.session_id;
      costUsd = msg.total_cost_usd ?? msg.cost_usd;
      if (msg.result) output = msg.result;
      if (msg.model) model = msg.model;
      if (msg.usage) {
        inputTokens = msg.usage.input_tokens ?? 0;
        outputTokens = msg.usage.output_tokens ?? 0;
      }
    }
  }

  const succeeded = exitCode === 0;
  const transcript = transcriptParts.join("");
  const usage = inputTokens || outputTokens || costUsd !== undefined
    ? {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd ?? 0,
        model: model ?? "unknown",
      }
    : undefined;

  return {
    status: succeeded ? "completed" : "failed",
    output: output || (succeeded ? "Session completed." : `CLI exited with code ${exitCode}`),
    transcript: transcript || undefined,
    usage,
    cli_session_id: sessionId,
  };
}

/**
 * Convenience wrapper: split stdout on \n, parse each line, then build
 * the RuntimeResult. Use this when messages weren't already collected
 * during streaming (e.g. tests, or future non-streaming callers).
 */
export function parseClaudeStreamJson(
  stdout: string,
  exitCode: number | null,
): Omit<RuntimeResult, "process_pid" | "process_group_id"> {
  const messages: StreamJsonMessage[] = [];
  for (const line of stdout.split("\n")) {
    const msg = parseStreamJsonLine(line);
    if (msg) messages.push(msg);
  }
  return parseClaudeMessages(messages, exitCode);
}
