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
  /** Wrapper for SDK-shaped streaming events emitted by `--include-partial-messages`. */
  StreamEvent: "stream_event",
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

/** Inner shape of `stream_event.event`. We only inspect a handful of fields. */
interface StreamEventInner {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
  content_block?: ContentBlock;
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
  /** Present on `stream_event` messages (--include-partial-messages). */
  event?: StreamEventInner;
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

  // SDK-shaped streaming events from --include-partial-messages. Emit
  // text deltas as `agent` steps so the chat UI sees text appearing as
  // the model writes it. Tool input deltas (`input_json_delta`) are
  // skipped — we wait for the whole tool input on the post-block
  // `assistant` message so the tool_call step has full args.
  if (msg.type === STREAM_TYPE.StreamEvent && msg.event) {
    const ev = msg.event;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      const text = ev.delta.text ?? "";
      if (text.length === 0) return [];
      return [
        {
          kind: "agent",
          description: text,
          timestamp: now,
        },
      ];
    }
    return [];
  }

  // Whole-`assistant` message at end of each block. Text blocks were
  // already streamed as deltas above (we always run with
  // `--include-partial-messages`), so we only surface tool_use blocks
  // here — they need the full input which deltas can't carry.
  if (msg.type === STREAM_TYPE.Assistant && msg.message && Array.isArray(msg.message.content)) {
    const out: RuntimeStep[] = [];
    for (const block of msg.message.content) {
      if (block.type === BLOCK_TYPE.ToolUse) {
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

/**
 * Pull the most informative human-readable field out of a tool's input
 * payload. Used by the chat UI's "what's the agent doing right now"
 * bubble — the goal is "Read packages/foo.ts" not "{file_path: ...}".
 *
 * The first matching field wins; ordering reflects which tools we want
 * to surface most prominently. Mesh and team-management fields come
 * BEFORE generic ones (file_path, command) so when an agent calls
 * `create_subordinate_agent({name: "Backend"})` we see the name, not a
 * blob of JSON.
 */
function describeToolInput(input: Record<string, unknown>): string {
  // Mesh + team-management tools — most demo-relevant.
  if (typeof input.question === "string") return input.question.slice(0, 200);
  if (typeof input.answer === "string") return input.answer.slice(0, 200);
  if (typeof input.intent === "string") return input.intent.slice(0, 200);
  if (typeof input.feedback === "string") return input.feedback.slice(0, 200);
  if (typeof input.proposal === "string") return input.proposal.slice(0, 200);
  if (typeof input.blocker_summary === "string") return input.blocker_summary.slice(0, 200);
  if (typeof input.summary === "string") return input.summary.slice(0, 200);
  // Identity-style fields used by create_subordinate_agent / get_agent_profile.
  if (typeof input.name === "string" && typeof input.persona === "string")
    return input.name.slice(0, 80);
  // Generic Claude Code native tools.
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command.slice(0, 200);
  if (typeof input.query === "string") return input.query.slice(0, 200);
  if (typeof input.pattern === "string") return input.pattern.slice(0, 200);
  if (typeof input.path === "string") return input.path;
  if (typeof input.url === "string") return input.url;
  // Fall back to a single named field if there's only one, else JSON.
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]!] === "string") {
    return (input[keys[0]!] as string).slice(0, 200);
  }
  return JSON.stringify(input).slice(0, 200);
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
