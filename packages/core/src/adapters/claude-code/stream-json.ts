import type { RuntimeResult, RuntimeStep } from "../../ports/runtime.js";

/**
 * Parser for Claude Code's `--output-format stream-json` output.
 *
 * Each line of stdout is a JSON message with a `type` discriminator.
 * We parse two ways:
 *  - Line-at-a-time (`parseStreamJsonLine`) for streaming step extraction
 *    via `RuntimeContext.onStep`.
 *  - Whole-stdout (`parseClaudeStreamJson`) after process exit to produce
 *    a `RuntimeResult`.
 */

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
  [key: string]: unknown;
}

/** Parse a single stream-json line. Returns null for empty/invalid input. */
export function parseStreamJsonLine(line: string): StreamJsonMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as StreamJsonMessage;
  } catch {
    return null;
  }
}

/**
 * Extract a RuntimeStep from a stream-json message. Returns null if the
 * message isn't a tool-use event.
 */
export function extractStepEvent(msg: StreamJsonMessage): RuntimeStep | null {
  // Direct tool_use message
  if (msg.type === "tool_use" || msg.subtype === "tool_use") {
    const toolName = msg.name ?? "unknown";
    const input = msg.input ?? {};
    return {
      tool: toolName,
      description: describeToolInput(input),
      timestamp: new Date().toISOString(),
    };
  }

  // Content-block-start with a tool_use block inside
  if (msg.type === "content_block_start" && msg.content_block) {
    const block = msg.content_block;
    if (block.type === "tool_use") {
      return {
        tool: block.name ?? "unknown",
        description: describeToolInput((block.input ?? {}) as Record<string, unknown>),
        timestamp: new Date().toISOString(),
      };
    }
  }

  return null;
}

function describeToolInput(input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command.slice(0, 100);
  if (typeof input.query === "string") return input.query.slice(0, 100);
  return JSON.stringify(input).slice(0, 100);
}

/**
 * Post-hoc parse of accumulated stdout into a RuntimeResult.
 *
 * Extracts the last assistant text as `output`, the final `result` message
 * for cli_session_id + cost + usage + model, and builds a human-readable
 * transcript with tool_use/tool_result correlation via tool_use_id.
 *
 * Note: does not decide between `completed` / `cancelled` — caller
 * (ClaudeCodeRuntime) supplies `cancelled` when the process was aborted
 * before exit. This function only distinguishes `completed` (exit 0) from
 * `failed` (non-zero).
 */
export function parseClaudeStreamJson(
  stdout: string,
  exitCode: number | null,
): Omit<RuntimeResult, "process_pid" | "process_group_id"> {
  const lines = stdout.split("\n");
  const messages: StreamJsonMessage[] = [];
  for (const line of lines) {
    const msg = parseStreamJsonLine(line);
    if (msg) messages.push(msg);
  }

  // Map tool_use_id → tool name so tool_result lines can say what tool
  // they came from. Without this the transcript has opaque "[tool_result]"
  // entries that mislead future LLM consumers.
  const toolUseNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type === "assistant" && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseNames.set(block.id, block.name ?? "unknown");
        }
      }
    }
  }

  let output = "";
  let sessionId: string | undefined;
  let costUsd: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;
  let transcript = "";

  for (const msg of messages) {
    if (msg.type === "assistant" && msg.message) {
      const content = msg.message.content;
      if (typeof content === "string") {
        transcript += `[assistant] ${content}\n`;
        output = content;
      } else if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            transcript += `[assistant] ${block.text}\n`;
            texts.push(block.text);
          } else if (block.type === "tool_use") {
            transcript += `[tool_call] ${block.name ?? "unknown"}\n`;
          }
          // Skip thinking blocks + signatures — they bloat the transcript.
        }
        if (texts.length > 0) output = texts.join("\n");
      }
    } else if (msg.type === "tool_use") {
      transcript += `[tool_call] ${msg.name ?? "unknown"}\n`;
    } else if (msg.type === "tool_result") {
      const toolUseId = (msg as { tool_use_id?: string }).tool_use_id;
      const toolName = toolUseId ? toolUseNames.get(toolUseId) : undefined;
      const resultContent =
        typeof msg.content === "string"
          ? msg.content.slice(0, 200).replace(/\n/g, " ")
          : "";
      if (toolName) {
        transcript += resultContent
          ? `[tool_result from ${toolName}] ${resultContent}\n`
          : `[tool_result from ${toolName}]\n`;
      } else {
        transcript += "[tool_result]\n";
      }
    }

    if (msg.type === "result") {
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
