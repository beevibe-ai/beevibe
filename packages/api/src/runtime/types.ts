/**
 * Wire types for the /runtime/* surface. Shared between the api server
 * (handlers in router.ts) and any daemon implementation (packages/daemon
 * lands in Phase 5). Kept in @beevibe/api for now; promote to a shared
 * package if more consumers need them.
 */

import type {
  SessionEventKind,
  SessionStatus,
  SessionType,
  SessionUsage,
} from "@beevibe/core";

/* ─── Register ───────────────────────────────────────────────────────── */

export interface RuntimeRegisterRequest {
  /** Stable per-machine id chosen by the daemon and persisted in its config. */
  external_id: string;
  /** Human-readable label shown in the Runtimes panel. */
  device_name: string;
  /** One entry per detected CLI on PATH. Empty list rejected. */
  runtimes: Array<{
    cli: string;
    cli_version?: string;
  }>;
}

export interface RuntimeRegisterResponse {
  daemon_id: string;
  /** Plaintext bv_d_ token. Server retains only the SHA-256 hash. */
  daemon_token: string;
  runtimes: Array<{ id: string; cli: string }>;
}

/* ─── Heartbeat ──────────────────────────────────────────────────────── */

export interface RuntimeHeartbeatRequest {
  runtime_ids: string[];
}

/* ─── Claim ──────────────────────────────────────────────────────────── */

/**
 * Server's response to /runtime/claim. Everything the daemon needs to
 * spawn the CLI: agent token (writes into mcp-config.json), intent,
 * system_prompt_append (briefing), resume cli_session_id, model + max_turns.
 *
 * `workspace_subdir` is relative to the daemon's workspace root
 * (~/.beevibe/workspaces) — typically the agent_id. The daemon owns the
 * filesystem layout; the server doesn't track full local paths.
 */
export interface DispatchPayload {
  session_id: string;
  agent_id: string;
  /** bv_a_ token; goes into mcp-config.json's Authorization header. */
  agent_api_key: string;
  workspace_subdir: string;
  intent: string;
  system_prompt_append: string;
  /** When set, daemon spawns with `--resume <cli_session_id>`. */
  resume_session_id?: string;
  model?: string;
  max_turns?: number;
  /** Session-scoped env vars; daemon merges with its own when spawning. */
  env: Record<string, string>;
  type: SessionType;
  /** /mcp endpoint daemon writes into mcp-config.json. */
  mcp_server_url: string;
}

/* ─── Events (live transcript) ───────────────────────────────────────── */

export interface RuntimeEventInput {
  session_id: string;
  kind: SessionEventKind;
  content: string;
  tool_name?: string;
}

export interface RuntimeEventsRequest {
  events: RuntimeEventInput[];
}

/* ─── Done (terminal state) ──────────────────────────────────────────── */

export interface RuntimeDoneRequest {
  session_id: string;
  /** 'succeeded' | 'failed' | 'cancelled'. */
  status: Exclude<SessionStatus, "pending" | "running">;
  cli_session_id?: string;
  result_summary?: string;
  exit_code?: number;
  error?: string;
  usage?: SessionUsage;
}
