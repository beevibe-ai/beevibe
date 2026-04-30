/**
 * Read-side DTOs returned by the views layer (`packages/api/src/views/*`).
 *
 * Single source of truth for the web's read contract. Web re-exports these
 * via `@beevibe/api/views/types` (subpath export). Defining them here means:
 *
 *   - Backend changes the shape → TypeScript errors in web (`pnpm typecheck`)
 *   - Web bends to the backend contract, never the other way around
 *
 * **Independence:** these DTOs `Pick`/`Omit` from core's domain types so the
 * column-level shape stays in sync, but they live in the API package — they
 * carry display denormalizations (labels, counts, joined rows) that are
 * UI-shaped, not domain-shaped, and don't belong on `Task` / `Agent` /
 * `Session`. Core stays untouched.
 */

import type {
  Agent,
  HierarchyLevel,
  Task,
  TaskStatus,
  WorkProduct,
  FactType,
  MemoryScope,
  SessionStatus,
  SessionType,
} from "@beevibe/core";

/**
 * Lightweight rich-text encoding used in places where we want inline `mono`
 * spans (e.g., description bodies, task summaries). Mirrors the web
 * component's accepted shape — but defined here so the type lives in the
 * package that owns the contract, not in a UI component file. The web's
 * <RichTextRender> consumes the same structural shape.
 */
export type RichSegment = string | { mono: string };
export type RichText = string | RichSegment[];

// ── Tasks ───────────────────────────────────────────────────────────────────

export interface TaskListItem extends Omit<Task, "description" | "result_summary"> {
  /** Joined from the assignee agent (if any). */
  assignee_hierarchy?: HierarchyLevel;
  /** Human-readable assignee name (joined from agent.name). */
  assignee_label?: string;
  /** Human-readable creator label (agent.name or person.display_name). */
  creator_label?: string;
  description?: RichText[];
  result_summary?: RichText;
  session_count?: number;
  work_product_count?: number;
  /** Snapshot of the most recent session for inline rendering. */
  latest_session?: TaskLatestSessionSummary;
}

export interface TaskLatestSessionSummary {
  short_id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  /** "2m", "1h", etc. — relative duration label. */
  elapsed: string;
  agent_label: string;
}

export interface TaskDetailSessionRow {
  id: string;
  short_id: string;
  agent_id: string;
  agent_label: string;
  status: SessionStatus;
  started_at: Date;
  duration_label: string;
  result_summary?: string;
}

export interface TaskDetail extends TaskListItem {
  work_products: WorkProduct[];
  sessions: TaskDetailSessionRow[];
}

// ── Agents ──────────────────────────────────────────────────────────────────

export interface AgentDisplay
  extends Pick<
    Agent,
    "id" | "name" | "owner_id" | "parent_agent_id" | "hierarchy_level" | "created_at" | "updated_at"
  > {
  /** Defaults to `name` but the UI may want a different display string. */
  display_name: string;
  hierarchy: HierarchyLevel;
  sessions_count?: number;
  facts_learned?: number;
  /** Reserved for future memory-merge telemetry. */
  merge_events?: number;
  specialization?: string;
  themes?: string[];
  runtime?: string;
  review_policy?: string;
}

export interface RecentSession {
  short_id?: string;
  title: string;
  status: "running" | "succeeded" | "review";
  /** Relative-time label, e.g. "2m". */
  age: string;
}

export interface OutgoingMeshHint {
  target: string;
  intent: string;
  age: string;
}

export interface CoreBlockDisplay {
  id: string;
  agent_id: string;
  block_name: string;
  content: string;
  char_count: number;
  char_limit: number;
  is_system: boolean;
  /** Rendered "updated 3d ago"-style label. */
  updated_label: string;
}

export interface AgentMetrics {
  sessions: number;
  /** Delta vs. prior period — backend may set 0 if not computed. */
  sessions_change: number;
  facts: number;
  merges: number;
  promoted: number;
}

export interface AgentDetail extends AgentDisplay {
  core_blocks: CoreBlockDisplay[];
  metrics: AgentMetrics;
  recent_sessions: RecentSession[];
  outgoing_mesh_hints: OutgoingMeshHint[];
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface TranscriptEntry {
  kind: "agent" | "tool_call" | "tool_result" | "summary";
  /** ISO timestamp string. */
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

export interface SessionDisplay {
  id: string;
  short_id: string;
  task_id: string;
  task_title: string;
  task_short_id: string;
  agent_id: string;
  agent_label: string;
  agent_hierarchy: HierarchyLevel;
  type: SessionType;
  status: SessionStatus;
  intent: string;
  started_at: Date;
  duration_label: string;
  worktree?: string;
  cli_session?: string;
  briefing: SessionBriefing;
  transcript: TranscriptEntry[];
  ask_threads?: AskThread[];
}

export interface SessionBriefing {
  block_count: number;
  fact_count: number;
  token_count: number;
  blocks: Array<{ name: string; chars: number; preview: string }>;
  facts: Array<{ scope: HierarchyLevel; content: string; score: number }>;
}

// ── Memory facts ────────────────────────────────────────────────────────────

export type MergeOrigin = "merged" | "promoted" | "single";

export interface MemoryFactDisplay {
  id: string;
  content: RichText;
  fact_type: FactType;
  scope: MemoryScope;
  agent_id: string;
  agent_label: string;
  source_session_count: number;
  created_at: Date;
  merge_origin?: MergeOrigin;
  promotion_origin_scope?: MemoryScope;
}

// ── Re-exports of ambient types that web imports alongside the DTOs ─────────

export type { TaskStatus };
