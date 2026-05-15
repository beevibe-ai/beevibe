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
  SessionSpawnMode,
  Task,
  TaskStatus,
  WorkProduct,
  FactType,
  MemoryScope,
  SessionEventKind,
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
  status: SessionStatus;
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
  /** Human-readable owner name (joined from person.name). */
  owner_label?: string;
  /** Defaults to `name` but the UI may want a different display string. */
  display_name: string;
  hierarchy: HierarchyLevel;
  sessions_count?: number;
  facts_learned?: number;
  /** Reserved for future memory-merge telemetry. */
  merge_events?: number;
  specialization?: string;
  themes?: string[];
  /** CLI tool the agent uses — derived from `runtime_config.type`. */
  runtime?: string;
  /**
   * Model alias passed to the CLI (e.g. "opus", "sonnet"). Undefined when
   * the agent uses the CLI's user-configured default model.
   */
  model?: string;
  review_policy?: string;
  /**
   * The agent's pinned `runtime` row id. The Runtimes panel uses this to
   * derive an online dot (lookup runtime_id in the cached runtimes list).
   * Null for agents without a daemon yet (e.g. legacy seeded fixtures).
   */
  preferred_runtime_id?: string;
  /** ISO timestamp when archived; absent for live agents. */
  archived_at?: string;
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
  kind: SessionEventKind;
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

/**
 * Per-session usage telemetry exposed to the UI. Derived from the
 * `SessionUsage` JSONB column on `session`. All numeric fields default
 * to 0 (older sessions captured before M9.8 have null `usage`, in which
 * case the whole object is absent from `SessionDisplay`).
 *
 * `cache_hit_ratio` is precomputed server-side so every consumer agrees
 * on the formula:
 *   cache_hit_ratio = cache_read_tokens / total_input_tokens
 *   total_input_tokens = input_tokens + cache_creation_tokens + cache_read_tokens
 *
 * Range [0, 1]; 0 when no input was processed.
 */
export interface SessionUsageDisplay {
  /** Total cost in USD for this session, summed across all assistant turns. */
  cost_usd: number;
  /** Cache hit ratio in [0, 1]. Target >0.7 on a warm second-onward session. */
  cache_hit_ratio: number;
  /** Fresh input tokens (not served from cache). */
  input_tokens: number;
  /** Output tokens generated. */
  output_tokens: number;
  /** Tokens written to cache (charged at ~1.25× base input rate). */
  cache_creation_tokens: number;
  /** Tokens read from cache (charged at ~0.1× base input rate). */
  cache_read_tokens: number;
  /** Sum of input + cache_creation + cache_read. Convenience for UI. */
  total_input_tokens: number;
  /** Model used. Falls back to "unknown" if the runtime didn't report one. */
  model: string;
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
  /**
   * Where the session ran. `'daemon'` is the normal path (matched runtime
   * on a user's machine); `'server_fallback_mesh'` is the restricted-tool
   * path used when a mesh target's daemon is offline (Phase 7 work).
   */
  spawn_mode?: SessionSpawnMode;
  /** Pinned runtime for this session; absent for server-fallback sessions. */
  runtime_id?: string;
  /** Joined from runtime: CLI name (e.g. "claude"). */
  runtime_cli?: string;
  /** Joined from runtime: CLI version captured at register time. */
  runtime_cli_version?: string;
  /** Joined from daemon → device_name. Renders as "Ran on <X>". */
  daemon_device_name?: string;
  /**
   * Per-session cost + token usage. Absent when the underlying
   * `session.usage` JSONB column is null (older sessions captured
   * before M9.8 stamped usage onto every completion). See
   * {@link SessionUsageDisplay} for field semantics + cache-hit ratio
   * formula.
   */
  usage?: SessionUsageDisplay;
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

/**
 * Per-scope fact counts for the /memory page's tab badges. Owner-scoped
 * and unfiltered — the badges have to stay stable regardless of which
 * scope tab is currently selected on the page.
 */
export interface MemoryFactCounts {
  total: number;
  ic: number;
  team: number;
  org: number;
}

// ── Dashboard ───────────────────────────────────────────────────────────────
//
// The dashboard DTO is intentionally pure data. The web composes display
// fields (colors, hrefs, sparkline geometry, day labels, "5m ago" age) via
// `summaryToDisplay()` in `lib/dashboard-display.ts`. Backend shouldn't know
// the URL structure or status→color CSS map.

/**
 * Discriminator that lets the web's mapper attach UI config (label, href,
 * trend chart kind, color enum) per KPI. Adding a new KPI: define a new
 * kind here, return a row from `views/dashboard.ts`, and add the display
 * mapping on the web side. No coupled config tables in the backend.
 */
export type KpiKind =
  | "active_sessions"
  | "in_review"
  | "completed_today"
  | "blocked";

export interface KpiData {
  kind: KpiKind;
  value: number;
  unit?: string;
  /** Last 7 daily counts, oldest → newest. */
  trend: number[];
}

export interface StatusBreakdownData {
  status: TaskStatus;
  count: number;
  percent: number;
}

/**
 * Legend entries are coarser than the breakdown: lifecycle groupings
 * mapped onto the UI's 6 status dots. The mapper (web) joins these with
 * label + color.
 */
export type LegendBucket =
  | "review"
  | "done"
  | "blocked"
  | "failed"
  | "running"
  | "pending";

export interface StatusLegendData {
  bucket: LegendBucket;
  count: number;
}

export interface FleetBarData {
  hier: HierarchyLevel;
  count: number;
  percent: number;
}

export interface TrendDayData {
  /** ISO date (`YYYY-MM-DD`) — web maps to a short day label like "Mon". */
  date: string;
  value: number;
  is_today: boolean;
}

export interface AttentionData {
  task_id: string;
  title: string;
  status: "blocked" | "failed" | "review";
  /** ISO timestamp; web formats with `formatRelativeTime`. */
  created_at: Date;
}

/**
 * Per-agent slice of the dashboard usage aggregate. Sorted by `cost_usd`
 * descending so the UI can render top-N spenders without re-sorting.
 */
export interface UsageAgentBreakdown {
  agent_id: string;
  agent_label: string;
  cost_usd: number;
  sessions: number;
}

/**
 * Window-scoped cost + token rollup for the dashboard's Usage section.
 * `cost_change_percent` compares the current window to the prior window
 * of the same length — same convention as the existing `trend` block
 * (round to int percent; ±100% when prior was zero and current > 0).
 *
 * `cache_hit_ratio` is the weighted ratio across all sessions in the
 * window: total_cache_read / total_input. Range [0, 1]. Zero when no
 * input was processed in the window.
 */
export interface UsageSummaryData {
  /** Window length in days (matches TREND_WINDOW_DAYS). */
  window_days: number;
  total_cost_usd: number;
  prior_cost_usd: number;
  /** Round int percent vs. prior window. ±100% when prior was 0. */
  cost_change_percent: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  /** Weighted across the whole window. */
  cache_hit_ratio: number;
  total_sessions: number;
  /** Sorted by cost_usd descending. */
  per_agent: UsageAgentBreakdown[];
}

export interface DashboardSummary {
  kpis: KpiData[];
  status_breakdown: StatusBreakdownData[];
  status_legend: StatusLegendData[];
  status_total: number;
  fleet: FleetBarData[];
  fleet_total: number;
  fleet_active: number;
  fleet_idle: number;
  trend: TrendDayData[];
  trend_total: number;
  trend_change_percent: number;
  attention: AttentionData[];
  /** Cost + token aggregate over the current window. M9.8+. */
  usage_summary: UsageSummaryData;
}

// ── Mesh ────────────────────────────────────────────────────────────────────
//
// Mesh data DTO. Like the dashboard, the web composes display fields
// (SVG geometry, duration labels, color enums) via `lib/mesh-display.ts`
// and `lib/mesh-layout.ts`.
//
// V1 ships from the `negotiation` table (the canonical multi-round mesh
// activity). Mesh-ask sessions and blocker sessions are not yet surfaced
// here — their parent agent isn't directly stored on the session row, only
// embedded in the intent XML — and the live UI doesn't differentiate
// between ask types yet.

export type MeshAskType = "negotiate" | "ask" | "blocker";

export type MeshAskStatus =
  | "in_flight"
  | "succeeded"
  | "rejected"
  | "blocked"
  | "escalated";

export interface MeshAskData {
  id: string;
  type: MeshAskType;
  caller_id: string;
  caller_label: string;
  target_id: string;
  target_label: string;
  status: MeshAskStatus;
  /** First-round message; the web shows a preview. */
  intent: string;
  started_at: Date;
  completed_at?: Date;
  source_task_id?: string;
  /** Negotiations only. */
  rounds_completed?: number;
  max_rounds?: number;
}

export interface GraphNodeData {
  /** agent_id. */
  id: string;
  /** agent.name. */
  label: string;
  hier: HierarchyLevel;
  /** "active" if the agent is in any in-flight mesh activity. */
  state: "active" | "idle";
}

export interface GraphEdgeData {
  from: string;
  to: string;
  /** Number of asks/negotiations between this pair in the window. */
  count: number;
  /** "live" if any in-flight, "completed" otherwise. */
  state: "live" | "completed";
}

export interface MeshSummaryData {
  asks_24h: number;
  in_flight: number;
  edge_count: number;
}

export interface MeshOverview {
  asks: MeshAskData[];
  graph: { nodes: GraphNodeData[]; edges: GraphEdgeData[] };
  summary: MeshSummaryData;
}

// ── Promotions ─────────────────────────────────────────────────────────────
//
// Audit feed of FactPromoter decisions (promoted + rejected). Sourced from
// `memory_promotion_event` (M8.D), joined with memory_fact for content and
// agent for the originating label. Display fields (color enums, hrefs,
// relative ages) are computed web-side via direct binding — the page
// renders raw fields, no separate mapper needed for v1.

export interface PromotionEvent {
  id: string;
  fact_id: string;
  fact_type: FactType;
  fact_content: string;
  from_scope: MemoryScope | null;
  to_scope: MemoryScope;
  origin_agent_id: string;
  origin_agent_label: string;
  promoter_reason: string;
  source_session_ids: string[];
  /** Overflow count when the row had more than the truncation cap. */
  source_session_extra?: number;
  created_at: Date;
  rejected: boolean;
}

// ── Inbox — items the caller owes a decision on ─────────────────────────────

export type InboxItemKind = "task_review" | "task_blocked" | "escalation_pending";

export interface InboxItem {
  /** Composite, stable across kinds — `<kind>:<entity_id>`. */
  id: string;
  kind: InboxItemKind;
  /** Task title or escalation summary, truncated to 120 chars. */
  title: string;
  /** Secondary line — assignee/blocker label or counterparty list. */
  detail: string;
  /** Where to send the user when they click the row. */
  href: string;
  /** When the row entered the inbox state (review/blocked/pending). */
  age_at: Date;
}

// ── Agent network — caller's team + peer teams from shared rooms ────────────

export interface AgentPeerOwner {
  /** Person id that owns the peer team. */
  owner_id: string;
  /** Person's display name — surfaced as "Daniel's team" etc. in the UI. */
  owner_label: string;
  /** Full agent tree for that owner — team agent + ICs. */
  agents: AgentDisplay[];
}

export interface AgentNetwork {
  /** The caller's own agents (their orbit). */
  self: AgentDisplay[];
  /** Other people's agents the caller co-exists with via shared rooms. */
  peers: AgentPeerOwner[];
}

// ── Re-exports of ambient types that web imports alongside the DTOs ─────────

export type { TaskStatus };
