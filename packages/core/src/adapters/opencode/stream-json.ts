import type { SessionUsage } from "../../domain/session.js";
import type { RuntimeResult, RuntimeStep } from "../../ports/runtime.js";
import { bareCliExitMessage } from "../claude-code/stream-json.js";

/**
 * Parser for `opencode run --format json` output.
 *
 * Source: https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts
 * The `emit(type, data)` helper at the top of `run.ts` is the SOLE stdout
 * writer in JSON mode. Every event has the wrapper shape:
 *
 *     { type, timestamp, sessionID, ...payload }
 *
 * — note camelCase `sessionID`, not `session_id`. `UI.println`/`UI.error` go
 * to stderr; provider warnings (rate limits, model loading) also go to stderr.
 * Stdout in JSON mode is strictly NDJSON.
 *
 * Unlike codex, opencode has NO terminal `turn.completed` rollup event.
 * Usage + cost arrive PER STEP on `step_finish` events; this parser sums
 * them across the run.
 */

export const OPENCODE_EVENT_TYPE = {
  Text: "text",
  Reasoning: "reasoning",
  ToolUse: "tool_use",
  StepStart: "step_start",
  StepFinish: "step_finish",
  Error: "error",
} as const;

/**
 * `ToolState.status` from the opencode SDK. `error` carries `part.state.error`
 * (string); `completed` carries `part.state.output` (string).
 */
const OPENCODE_TOOL_STATUS = {
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Error: "error",
} as const;

export interface OpenCodePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  /** text / reasoning */
  text?: string;
  /** tool_use */
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
  };
  /** step_finish */
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { start?: number; end?: number };
}

export interface OpenCodeEvent {
  type?: string;
  timestamp?: number;
  /** Top-level on every line via emit()'s spread. NOT `session_id`. */
  sessionID?: string;
  part?: OpenCodePart;
  /** error event */
  error?: { message?: string };
  result?: { error?: { message?: string } };
}

export function parseOpenCodeEventLine(line: string): OpenCodeEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as OpenCodeEvent;
  } catch {
    return null;
  }
}

/**
 * Convert a parsed opencode event into 0+ RuntimeSteps for the live transcript.
 *
 * - `text` → one `agent` step with `part.text` (opencode emits text events
 *   only on part completion — `part.time?.end` is set — so there's no
 *   in-progress fragmentation to dedup).
 * - `tool_use` → `tool_call` while `state.status` is pending/running;
 *   `tool_result` once status flips to completed/error.
 * - `step_start` / `step_finish` / `reasoning` / `error` → no step (lifecycle
 *   or thinking; reasoning is already accounted for in tokens.reasoning).
 */
export function extractOpenCodeStepEvents(evt: OpenCodeEvent): RuntimeStep[] {
  const now = new Date().toISOString();

  if (evt.type === OPENCODE_EVENT_TYPE.Text) {
    const text = evt.part?.text?.trim();
    if (!text) return [];
    return [{ kind: "agent", description: text, timestamp: now }];
  }

  if (evt.type === OPENCODE_EVENT_TYPE.ToolUse) {
    const part = evt.part;
    if (!part) return [];
    const status = part.state?.status;
    const isTerminal =
      status === OPENCODE_TOOL_STATUS.Completed || status === OPENCODE_TOOL_STATUS.Error;
    return [
      {
        kind: isTerminal ? "tool_result" : "tool_call",
        tool: part.tool ?? "unknown",
        description: describeOpenCodeInput(part.state?.input),
        timestamp: now,
      },
    ];
  }

  return [];
}

const PREFERRED_OPENCODE_FIELDS = [
  "file_path",
  "path",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "intent",
] as const;

function describeOpenCodeInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 200);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const obj = input as Record<string, unknown>;
  for (const key of PREFERRED_OPENCODE_FIELDS) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 200);
  }
  return JSON.stringify(input).slice(0, 200);
}

/**
 * Build a `RuntimeResult` from a parsed event stream.
 *
 * `step_finish` events are SUMMED — opencode has no terminal rollup event,
 * so per-step tokens + cost are the only signal we get.
 *
 * `sessionID` is on every event; we just take the last one we see (they
 * should all match within a run).
 *
 * On failure (`exitCode !== 0` or any `error` event), prefer the error
 * event's message; final fallback is `bareCliExitMessage` so the chat
 * route's failure-mapping helper can swap it for stderr or a daemon
 * pointer.
 */
export function parseOpenCodeEvents(
  events: OpenCodeEvent[],
  exitCode: number | null,
): Omit<RuntimeResult, "process_pid" | "process_group_id"> {
  let sessionId: string | undefined;
  let sawUsage = false;
  let totalInput = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  const assistantTexts: string[] = [];
  const transcriptParts: string[] = [];
  let errorMessage: string | undefined;

  for (const evt of events) {
    if (evt.sessionID) sessionId = evt.sessionID;

    switch (evt.type) {
      case OPENCODE_EVENT_TYPE.StepFinish: {
        const part = evt.part;
        if (!part) break;
        sawUsage = true;
        totalCost += part.cost ?? 0;
        totalInput += part.tokens?.input ?? 0;
        totalOutput += part.tokens?.output ?? 0;
        totalReasoning += part.tokens?.reasoning ?? 0;
        totalCacheRead += part.tokens?.cache?.read ?? 0;
        totalCacheWrite += part.tokens?.cache?.write ?? 0;
        break;
      }
      case OPENCODE_EVENT_TYPE.Text: {
        const text = evt.part?.text;
        if (text) {
          assistantTexts.push(text);
          transcriptParts.push(`[assistant] ${text}\n`);
        }
        break;
      }
      case OPENCODE_EVENT_TYPE.ToolUse: {
        const part = evt.part;
        if (!part) break;
        const tool = part.tool ?? "unknown";
        const status = part.state?.status;
        if (status === OPENCODE_TOOL_STATUS.Completed || status === OPENCODE_TOOL_STATUS.Error) {
          const detail = (part.state?.error ?? part.state?.output ?? "")
            .slice(0, 200)
            .replace(/\n/g, " ");
          transcriptParts.push(
            detail ? `[tool_result from ${tool}] ${detail}\n` : `[tool_result from ${tool}]\n`,
          );
        } else {
          transcriptParts.push(`[tool_call] ${tool}\n`);
        }
        break;
      }
      case OPENCODE_EVENT_TYPE.Error:
        errorMessage = evt.error?.message ?? evt.result?.error?.message ?? errorMessage;
        if (errorMessage) transcriptParts.push(`[error] ${errorMessage}\n`);
        break;
      default:
        break;
    }
  }

  const assistantText = assistantTexts.join("\n").trim();
  const failed = exitCode !== 0 || !!errorMessage;
  // `||` not `??` — empty assistantText must fall through to the next
  // branch instead of short-circuiting at the empty string.
  const output = failed
    ? errorMessage || assistantText || bareCliExitMessage(exitCode)
    : assistantText || "Session completed.";

  const usage: SessionUsage | undefined = sawUsage
    ? {
        input_tokens: totalInput,
        // Per opencode's StepFinishPart shape, `output` is post-reasoning
        // assistant tokens; reasoning is its own bucket. Sum into a single
        // `output_tokens` like Anthropic's shape so downstream consumers
        // see one consistent number across runtimes.
        output_tokens: totalOutput + totalReasoning,
        cache_creation_input_tokens: totalCacheWrite,
        cache_read_input_tokens: totalCacheRead,
        cost_usd: totalCost,
      }
    : undefined;

  return {
    status: failed ? "failed" : "completed",
    output,
    transcript: transcriptParts.join("") || undefined,
    cli_session_id: sessionId,
    usage,
  };
}
