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
