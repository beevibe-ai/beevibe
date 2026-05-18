import type { RuntimeResult, RuntimeStep } from "../../ports/runtime.js";
import { bareCliExitMessage } from "../claude-code/stream-json.js";

/**
 * Parser for `codex exec --json` output.
 *
 * Source: https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs
 * The Rust `ThreadEvent` enum (`#[serde(tag = "type")]`) has 8 variants —
 * the canonical surface for codex's NDJSON stdout. Stdout is strictly
 * NDJSON per the contract at the top of `codex-rs/exec/src/lib.rs`:
 *
 *   "In --json mode, stdout must be valid JSONL, one event per line.
 *    Any other output must be written to stderr."
 *
 * Streaming text deltas are NOT exposed via `exec --json` — only
 * `item.started` / `item.updated` / `item.completed` snapshots. That's
 * why this parser emits `agent` steps only on `item.completed` for
 * `agent_message` items (and never tries to splice deltas).
 */

export const CODEX_EVENT_TYPE = {
  ThreadStarted: "thread.started",
  TurnStarted: "turn.started",
  TurnCompleted: "turn.completed",
  TurnFailed: "turn.failed",
  ItemStarted: "item.started",
  ItemUpdated: "item.updated",
  ItemCompleted: "item.completed",
  Error: "error",
} as const;

export const CODEX_ITEM_TYPE = {
  AgentMessage: "agent_message",
  Reasoning: "reasoning",
  CommandExecution: "command_execution",
  FileChange: "file_change",
  McpToolCall: "mcp_tool_call",
  CollabToolCall: "collab_tool_call",
  WebSearch: "web_search",
  TodoList: "todo_list",
  Error: "error",
} as const;

/** Subset of codex `turn.completed.usage` we surface; cache+reasoning split is codex-specific. */
interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/** Codex's `ThreadItem` — `{ id } & details` flattened, with details per `CODEX_ITEM_TYPE`. */
export interface CodexItem {
  id?: string;
  type?: string;
  /** agent_message + reasoning */
  text?: string;
  /** command_execution */
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  /** mcp_tool_call */
  tool?: string;
  server?: string;
  arguments?: unknown;
  result?: { content?: unknown[] } | null;
  error?: { message?: string } | null;
  /** web_search */
  query?: string;
  /** file_change */
  changes?: Array<{ path?: string; kind?: string }>;
  /** error item */
  message?: string;
}

export interface CodexEvent {
  type?: string;
  /** thread.started */
  thread_id?: string;
  /** turn.completed */
  usage?: CodexUsage;
  /** turn.failed */
  error?: { message?: string };
  /** item.started / item.updated / item.completed */
  item?: CodexItem;
  /** top-level error event */
  message?: string;
}

export function parseCodexEventLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }
}

/**
 * Convert a parsed codex event into 0+ RuntimeSteps for the live transcript.
 *
 * - `item.completed` + `agent_message` → one `agent` step with the final text.
 * - `item.started` + tool-ish items → `tool_call` step.
 * - `item.completed` + tool-ish items → `tool_result` step.
 * - `item.updated` → skipped (would dupe; codex emits started/updated/completed
 *   triples for each item and `updated` carries no new info we want).
 * - `reasoning` items → skipped (would bloat the transcript; reasoning is
 *   already counted in `turn.completed.usage.reasoning_output_tokens`).
 * - `turn.*` and `thread.*` → skipped (lifecycle events, not transcript content).
 */
export function extractCodexStepEvents(evt: CodexEvent): RuntimeStep[] {
  const now = new Date().toISOString();
  if (evt.type !== CODEX_EVENT_TYPE.ItemStarted && evt.type !== CODEX_EVENT_TYPE.ItemCompleted) {
    return [];
  }
  const item = evt.item;
  if (!item || !item.type) return [];
  const isCompletion = evt.type === CODEX_EVENT_TYPE.ItemCompleted;

  if (item.type === CODEX_ITEM_TYPE.AgentMessage) {
    if (!isCompletion) return [];
    const text = item.text?.trim();
    if (!text) return [];
    return [{ kind: "agent", description: text, timestamp: now }];
  }

  if (item.type === CODEX_ITEM_TYPE.McpToolCall) {
    return [
      {
        kind: isCompletion ? "tool_result" : "tool_call",
        tool: item.tool ?? "unknown",
        description: describeCodexInput(item.arguments),
        timestamp: now,
      },
    ];
  }

  if (item.type === CODEX_ITEM_TYPE.CommandExecution) {
    return [
      {
        kind: isCompletion ? "tool_result" : "tool_call",
        tool: "shell",
        description: (item.command ?? "").slice(0, 200),
        timestamp: now,
      },
    ];
  }

  if (item.type === CODEX_ITEM_TYPE.FileChange) {
    const summary = (item.changes ?? [])
      .map((c) => `${c.kind ?? "?"} ${c.path ?? ""}`)
      .join(", ")
      .slice(0, 200);
    return [
      {
        kind: isCompletion ? "tool_result" : "tool_call",
        tool: "file_change",
        description: summary,
        timestamp: now,
      },
    ];
  }

  if (item.type === CODEX_ITEM_TYPE.WebSearch) {
    return [
      {
        kind: isCompletion ? "tool_result" : "tool_call",
        tool: "web_search",
        description: (item.query ?? "").slice(0, 200),
        timestamp: now,
      },
    ];
  }

  return [];
}

/** Field-priority probe shared with claude's `describeToolInput` philosophy. */
const PREFERRED_CODEX_FIELDS = [
  "file_path",
  "path",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "intent",
] as const;

function describeCodexInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 200);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const obj = input as Record<string, unknown>;
  for (const key of PREFERRED_CODEX_FIELDS) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 200);
  }
  return JSON.stringify(input).slice(0, 200);
}

/**
 * Build a `RuntimeResult` from a parsed event stream + the codex-written
 * `--output-last-message` file contents. Caller passes `exitCode` from the
 * spawned process; non-zero or any `turn.failed` / top-level `error` event
 * maps to `status: "failed"`.
 *
 * Codex usage shape → `SessionUsage`: codex reports only one cache bucket
 * (`cached_input_tokens`, the cache-read total). We map it to
 * `cache_read_input_tokens` and leave `cache_creation_input_tokens` at 0 —
 * codex's API doesn't expose creation/read split the way Anthropic's does.
 * `cost_usd` is omitted entirely (codex's exec surface doesn't surface cost;
 * the dashboard does). `reasoning_output_tokens` is summed into output.
 */
export function parseCodexEvents(
  events: CodexEvent[],
  exitCode: number | null,
  lastMessage: string,
): Omit<RuntimeResult, "process_pid" | "process_group_id"> {
  let threadId: string | undefined;
  let usage: CodexUsage | undefined;
  let assistantText = "";
  let turnFailed: string | undefined;
  let topLevelError: string | undefined;
  const transcriptParts: string[] = [];

  for (const evt of events) {
    switch (evt.type) {
      case CODEX_EVENT_TYPE.ThreadStarted:
        if (evt.thread_id) threadId = evt.thread_id;
        break;
      case CODEX_EVENT_TYPE.TurnCompleted:
        if (evt.usage) usage = evt.usage;
        break;
      case CODEX_EVENT_TYPE.TurnFailed:
        turnFailed = evt.error?.message ?? turnFailed;
        break;
      case CODEX_EVENT_TYPE.Error:
        topLevelError = evt.message ?? topLevelError;
        if (evt.message) transcriptParts.push(`[error] ${evt.message}\n`);
        break;
      case CODEX_EVENT_TYPE.ItemCompleted: {
        const item = evt.item;
        if (!item || !item.type) break;
        if (item.type === CODEX_ITEM_TYPE.AgentMessage && item.text) {
          assistantText = item.text;
          transcriptParts.push(`[assistant] ${item.text}\n`);
        } else if (item.type === CODEX_ITEM_TYPE.McpToolCall) {
          const tool = item.tool ?? "unknown";
          transcriptParts.push(`[tool_call] ${tool}\n`);
          const resultSummary = summarizeMcpResult(item.result);
          if (resultSummary || item.error?.message) {
            transcriptParts.push(
              `[tool_result from ${tool}] ${item.error?.message ?? resultSummary}\n`,
            );
          }
        } else if (item.type === CODEX_ITEM_TYPE.CommandExecution) {
          transcriptParts.push(`[tool_call] shell ${(item.command ?? "").slice(0, 200)}\n`);
          if (item.aggregated_output) {
            transcriptParts.push(
              `[tool_result from shell] ${item.aggregated_output.slice(0, 200).replace(/\n/g, " ")}\n`,
            );
          }
        }
        break;
      }
      // item.started + item.updated emit RuntimeSteps via extractCodexStepEvents
      // but aren't included in the persisted transcript — only completions are.
      default:
        break;
    }
  }

  const failed = exitCode !== 0 || !!turnFailed || !!topLevelError;
  const trimmedLast = lastMessage.trim();
  const failureMessage = turnFailed ?? topLevelError;
  // Success: prefer the file-backed last message (codex writes the canonical
  // final assistant text there); fall back to the event-stream's last
  // agent_message; final fallback bareCliExitMessage so the chat-route's
  // failure-mapping helper can swap it for stderr/daemon-pointer. `||`
  // not `??` — empty assistantText must fall through to the next branch,
  // not short-circuit there.
  const output = failed
    ? failureMessage || assistantText || bareCliExitMessage(exitCode)
    : trimmedLast || assistantText || "Session completed.";

  return {
    status: failed ? "failed" : "completed",
    output,
    transcript: transcriptParts.join("") || undefined,
    cli_session_id: threadId,
    usage: usage
      ? {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
        }
      : undefined,
  };
}

function summarizeMcpResult(result: { content?: unknown[] } | null | undefined): string {
  if (!result || !Array.isArray(result.content)) return "";
  // MCP result content is `[{ type: "text", text: string }, ...]`. Surface
  // the first text block, trimmed; if none, fall back to a JSON snippet.
  for (const block of result.content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") return text.slice(0, 200).replace(/\n/g, " ");
    }
  }
  return JSON.stringify(result.content).slice(0, 200);
}
