import type { SessionStatus, SessionType } from "@beevibe/core";
import type { RichText } from "@/components/rich-text";

export interface SessionDisplay {
  id: string;
  short_id: string;
  task_id: string;
  task_title: string;
  task_short_id: string;
  agent_id: string;
  agent_label: string;
  agent_hierarchy: "ic" | "team" | "org";
  type: SessionType;
  status: SessionStatus;
  intent: string;
  started_at: Date;
  duration_label: string;
  worktree?: string;
  cli_session?: string;
  briefing: {
    block_count: number;
    fact_count: number;
    token_count: number;
    blocks: Array<{ name: string; chars: number; preview: string }>;
    facts: Array<{ scope: "ic" | "team" | "org"; content: string; score: number }>;
  };
  transcript: TranscriptEntry[];
  ask_threads?: AskThread[];
}

export interface TranscriptEntry {
  kind: "agent" | "tool_call" | "tool_result" | "summary";
  timestamp: string;
  content: string;
  tool_name?: string;
}

export interface AskThread {
  id: string;
  insert_after_index: number;
  caller: string;
  responder: string;
  arrow: "right" | "up";
  status: "succeeded" | "failed";
  duration_label: string;
  request: RichText;
  response: { agent: string; note?: string; content: RichText };
  chain_depth: string;
  spawned_session_label: string;
  tokens_label?: string;
  tone: "running" | "neutral";
}

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000);

export const fixtureSessions: SessionDisplay[] = [
  {
    id: "sess_3a8c000000000000000000000000",
    short_id: "sess_3a8c",
    task_id: "tsk_8a3f1c00000000000000000000",
    task_title: "Implement OAuth flow",
    task_short_id: "T-1014",
    agent_id: "agt_ic1",
    agent_label: "ic-agent-1",
    agent_hierarchy: "ic",
    type: "task",
    status: "succeeded",
    intent: "Wire OAuth refresh-token rotation",
    started_at: minutesAgo(18),
    duration_label: "ran 2m 14s",
    worktree: "~/.beevibe/workspaces/ic-agent-1/beevibe-T-1014",
    cli_session: "cli_8e2a4c",
    briefing: {
      block_count: 3,
      fact_count: 5,
      token_count: 2847,
      blocks: [
        {
          name: "persona",
          chars: 1376,
          preview: "You are a senior engineer specialized in authentication flows…",
        },
        {
          name: "domain",
          chars: 1728,
          preview: "Auth surface for this codebase: bv_a_ agent keys + bv_u_ user keys…",
        },
        {
          name: "constraints",
          chars: 1860,
          preview: "Never log full bearer tokens — log first-8-chars with hash suffix…",
        },
      ],
      facts: [
        {
          scope: "ic",
          content:
            "OAuth 2.1 strict mode rejects implicit grant entirely. For Claude Code CLI integration, use authorization-code-with-PKCE; bv_ keys exchange for short-lived bearer tokens via the token endpoint.",
          score: 0.91,
        },
        {
          scope: "team",
          content:
            "Postgres NOTIFY payload is capped at 8KB. Keep payloads to id, status, and timestamps; clients refetch full rows via HTTP after the event.",
          score: 0.87,
        },
        {
          scope: "ic",
          content:
            "When the OAuth provider config drifts, the failure surfaces as a 400 from /token, not a redirect failure. Log the upstream response body, not just status.",
          score: 0.85,
        },
        {
          scope: "org",
          content:
            "All inter-agent communication flows through the task queue and mesh tools, not direct calls. Async dispatch + synchronous mesh ask are the only two primitives.",
          score: 0.82,
        },
        {
          scope: "ic",
          content:
            "Refresh-token rotation requires storing both current and previous refresh tokens for a short window to handle in-flight requests. Single-token rotation breaks under retries.",
          score: 0.78,
        },
      ],
    },
    transcript: [
      {
        kind: "agent",
        timestamp: "00:00",
        content:
          "Starting refresh-token rotation. The task says we need rotation per OWASP guidance. Reading the current implementation in src/auth/oauth.ts.",
      },
      {
        kind: "tool_call",
        timestamp: "00:02",
        tool_name: "read_file",
        content: "src/auth/oauth.ts",
      },
      {
        kind: "tool_result",
        timestamp: "00:02",
        content: "Read 248 lines.",
      },
      {
        kind: "agent",
        timestamp: "00:14",
        content:
          "Current code stores only a single refresh token per session. Per the brief and the retrieved fact about in-flight retries, I need a previous_refresh_token column with a 60s TTL. Let me apply the migration.",
      },
      {
        kind: "tool_call",
        timestamp: "00:36",
        tool_name: "write_file",
        content: "migrations/1745000000000_oauth_refresh_rotation.sql",
      },
      {
        kind: "tool_result",
        timestamp: "00:36",
        content: "Wrote migration (24 lines).",
      },
      {
        kind: "agent",
        timestamp: "01:02",
        content:
          "Updating the rotation logic in src/auth/oauth.ts to write the new token and keep the previous one for 60s before clearing.",
      },
      {
        kind: "tool_call",
        timestamp: "02:08",
        tool_name: "run_tests",
        content: "tests/auth/oauth.test.ts",
      },
      {
        kind: "tool_result",
        timestamp: "02:14",
        content: "12/12 passing.",
      },
      {
        kind: "summary",
        timestamp: "02:14",
        content:
          "Implemented refresh-token rotation with 60s previous-token grace window. Migration applied. All 12 oauth tests passing. Submitted for review.",
      },
    ],
    ask_threads: [
      {
        id: "ath_a4f9",
        insert_after_index: 3,
        caller: "ic-agent-1",
        responder: "db-agent",
        arrow: "right",
        status: "succeeded",
        duration_label: "resolved · 8s",
        tone: "running",
        request:
          "Schema for refresh-token storage? Need a column for the encrypted blob plus rotation metadata (last_rotated_at, rotation_count) with a unique index by user_id. Concurrent rotation has to be safe.",
        response: {
          agent: "db-agent",
          note: "answered from its own bounded memory",
          content: [
            "Add ",
            { mono: "refresh_token" },
            " table — columns: ",
            { mono: "id, user_id (UQ), encrypted_blob BYTEA, last_rotated_at TIMESTAMPTZ, rotation_count INT" },
            ". Read with ",
            { mono: "FOR UPDATE SKIP LOCKED" },
            " in the rotation flow, or two concurrent rotations race the increment. Migration template at ",
            { mono: "migrations/_template_with_partial_index.sql" },
            ".",
          ],
        },
        chain_depth: "1/4",
        spawned_session_label: "session sess_a4f9 spawned for db-agent",
        tokens_label: "1,128 tokens used of chain budget",
      },
      {
        id: "ath_b8c3",
        insert_after_index: 6,
        caller: "ic-agent-1",
        responder: "team-alpha",
        arrow: "up",
        status: "succeeded",
        duration_label: "resolved · 14s",
        tone: "neutral",
        request:
          "Sanity check the OAuth refresh-token rotation: KMS-backed encryption, FOR UPDATE SKIP LOCKED on read, increment-on-rotate, fails closed if KMS key missing. Sound for prod?",
        response: {
          agent: "team-alpha",
          note: "approved with one note",
          content: [
            "Sound. Add a metric on ",
            { mono: "rotation_count" },
            " per user — anomalous spikes are how we'll catch a stolen-token replay. Open a follow-up task; not blocking this one.",
          ],
        },
        chain_depth: "1/4",
        spawned_session_label: "session sess_b8c3 spawned for team-alpha",
      },
    ],
  },
];

export function findSessionById(idOrShort: string): SessionDisplay | undefined {
  const exact = fixtureSessions.find((s) => s.id === idOrShort || s.short_id === idOrShort);
  if (exact) return exact;
  return fixtureSessions[0];
}
