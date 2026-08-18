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
  WorkProductType,
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

/**
 * Cap for `RecentChatThread.title` and the identical `title` on the
 * chat-conversation list (`routes/chat.ts`). Both endpoints derive that
 * title from the head turn's intent, so the cap has to be one constant —
 * two values would render the same thread under two different titles
 * depending on which page you opened.
 */
export const CHAT_THREAD_TITLE_MAX = 80;

/**
 * Recent chat conversation surfaced on the agent detail page as one
 * collapsed card per thread. Each thread groups N chat-turn sessions
 * sharing the same `conversation_id` (the head turn's session id —
 * stamped by the postgres SessionRepository INSERT, backfilled by
 * migration 1781200000000). The web renders this as an expandable card
 * showing the first message as the title and `turn_count` turns inside.
 *
 * Distinct from `RecentSession` (which now excludes chat) — task
 * sessions render as today, one row per session.
 */
export interface RecentChatThread {
  /** Head session id of the thread; stable across all turns. */
  conversation_id: string;
  /**
   * 6-char short_id of the head turn (`deriveShortId(conversation_id)`) —
   * the URL key the web uses to link to the conversation detail page at
   * `/sessions/<short_id>`. Precomputed here so the web doesn't re-derive
   * it (and can't drift from the server's `short_id` convention).
   */
  short_id: string;
  /** First message of the thread, truncated to 80 chars. */
  title: string;
  /** How many chat sessions are in the thread. */
  turn_count: number;
  /** Relative-time label for the most recent turn, e.g. "2m". */
  age: string;
  /**
   * Status of the latest turn. Drives the in-flight pip — when a chat
   * turn is mid-LLM-call, the card shows "running"; on succeeded /
   * failed / cancelled it goes idle.
   */
  last_status: "running" | "succeeded" | "review";
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
  /**
   * Recent non-chat sessions (task / mesh / blocker / run_repo). Chat
   * sessions are surfaced via `recent_chat_threads` so heavy chat usage
   * doesn't drown out actual task work in this list.
   */
  recent_sessions: RecentSession[];
  /** Recent chat conversations, collapsed by `conversation_id`. */
  recent_chat_threads: RecentChatThread[];
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

/**
 * A whole chat conversation — every chat-turn session sharing one
 * `conversation_id`, rendered as a single continuous thread on the
 * session detail page. Returned by `GET /session/:shortId/conversation`.
 *
 * Each chat turn is its own `session` row (chained by `prior_session_id`,
 * resuming the same CLI session). This collapses N of them into one view:
 * the `turns` array is chronological (oldest first), each turn a full
 * `SessionDisplay` with its own transcript + usage.
 *
 * Non-chat sessions (`conversation_id` is NULL — task / mesh / blocker /
 * negotiate) resolve to a single-turn conversation containing just that
 * session, so the detail page renders them unchanged.
 */
export interface ConversationDisplay {
  /** Grouping key: head turn's id for chat; the session's own id otherwise. */
  conversation_id: string;
  /** 6-char short_id of the head turn — the URL key for this conversation. */
  short_id: string;
  agent_id: string;
  agent_label: string;
  agent_hierarchy: HierarchyLevel;
  /**
   * Type of the addressed session. Lets the detail page keep the
   * task-session redirect (`type === 'task'` → task-scoped page).
   */
  type: SessionType;
  /** Set when `type === 'task'`; drives the task-scoped redirect. */
  task_id?: string;
  /** Status of the latest turn — drives the in-flight pip on the header. */
  status: SessionStatus;
  /** Turns in chronological order (oldest first), each with its transcript. */
  turns: SessionDisplay[];
  /**
   * Cost + tokens summed across every turn, so the detail page renders one
   * conversation-level usage panel. Absent when no turn carried usage.
   * Aggregated server-side (same cache-hit formula as per-session usage)
   * rather than recomputed in the browser.
   */
  usage?: SessionUsageDisplay;
}

/**
 * Slim metadata for a single session in a spawn tree. Returned by
 * `GET /session/:id/tree` for chat-UI hydration. Transcripts and step
 * events come via the SSE stream — the tree endpoint only ships the
 * structural snapshot of who-spawned-whom that the browser needs to
 * lay out inline IC blocks.
 */
export interface SessionTreeNode {
  id: string;
  short_id: string;
  parent_session_id: string | null;
  agent_id: string;
  agent_label: string;
  agent_hierarchy: HierarchyLevel;
  task_id: string | null;
  task_short_id: string | null;
  task_title: string | null;
  type: SessionType;
  status: SessionStatus;
  intent: string;
  /** ISO 8601. Null when the session row exists but hasn't been claimed. */
  started_at: string | null;
  /** ISO 8601. Null while the session is still in-flight. */
  completed_at: string | null;
}

export interface SessionTreeResponse {
  root: SessionTreeNode;
  descendants: SessionTreeNode[];
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
 * mapped onto the UI's status dots. The mapper (web) joins these with
 * label + color.
 */
export type LegendBucket =
  | "review"
  | "done"
  | "blocked"
  | "failed"
  | "cancelled"
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

// ── Memory activity (Layer A eval) ──────────────────────────────────────────
//
// Powers the /memory/eval dashboard. Activity-level signal — what got
// written, by whom, when, of what type — plus an optional ±14d before/after
// split for evaluating prompt-change rollouts. Pure data composer; web
// formats display fields.

export interface MemoryActivityKpis {
  archival_writes_30d: number;
  /** Distinct core blocks with updated_at within 30d. Snapshot proxy. */
  core_touched_30d: number;
  active_agents_30d: number;
  /** archival_writes_30d / core_touched_30d, rounded to 1 decimal. null if denominator is 0. */
  archival_to_core_ratio: number | null;
}

export interface WeeklyArchivalRow {
  /** Week-start (Monday) in YYYY-MM-DD. */
  week: string;
  total: number;
  belief: number;
  pattern: number;
  gotcha: number;
  preference: number;
  decision: number;
  active_agents: number;
}

export interface ScopeTypeRow {
  scope: "ic" | "team" | "org";
  fact_type: string;
  writes: number;
}

export interface AgentActivityRow {
  agent_id: string;
  name: string;
  tier: string;
  writes_30d: number;
  type_variety: number;
  /** YYYY-MM-DD. */
  last_write: string;
}

export interface DormantAgentRow {
  agent_id: string;
  name: string;
  tier: string;
  /** YYYY-MM-DD, or null if agent has never written archival. */
  last_write_ever: string | null;
  agent_created: string;
}

export interface CoreSnapshotRow {
  tier: string;
  block_name: string;
  blocks: number;
  non_empty: number;
  ever_updated: number;
  updated_30d: number;
  avg_chars: number;
}

export interface AgentRatioRow {
  agent_id: string;
  name: string;
  tier: string;
  archival_30d: number;
  core_touched_30d: number;
  /** null when core_touched_30d == 0 (caller renders as "—" rather than ∞). */
  ratio: number | null;
}

export interface BeforeAfterData {
  /** The boundary date, as passed in by the caller. */
  since: string;
  by_type: Array<{
    fact_type: string;
    pre: number;
    post: number;
    pre_pct: number | null;
    post_pct: number | null;
  }>;
  agg: {
    agents_pre: number;
    agents_post: number;
    writes_pre: number;
    writes_post: number;
  };
}

export interface MemoryActivitySummary {
  /** Echoed back so the web doesn't need to track local state. */
  weeks: number;
  /** Echoed back; null when ?since= wasn't provided. */
  since: string | null;
  kpis: MemoryActivityKpis;
  weekly_archival: WeeklyArchivalRow[];
  by_scope_and_type: ScopeTypeRow[];
  top_agents: AgentActivityRow[];
  dormant_agents: DormantAgentRow[];
  core_snapshot: CoreSnapshotRow[];
  archival_to_core_per_agent: AgentRatioRow[];
  /** Present only when ?since= was provided. */
  before_after?: BeforeAfterData;
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

/**
 * Time window the mesh page can show. Driven by the header pill row.
 * `"all"` lifts the time filter entirely (still capped by the row LIMIT).
 */
export const MESH_WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type MeshWindow = (typeof MESH_WINDOWS)[number];

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

// ── Runtimes panel — daemons and their CLIs ─────────────────────────────────
//
// Emitted by `GET /runtimes` (`routes/runtimes.ts`, which projects rows with
// `satisfies RuntimesListResponse`). Absent values are sent as explicit
// `null`, not omitted — the projection normalizes `undefined` away — so these
// fields are nullable rather than optional.

export interface RuntimePanelEntry {
  id: string;
  cli: string;
  cli_version: string | null;
  /** ISO last_heartbeat, or null when the runtime has never beat. */
  last_heartbeat: string | null;
  /** True iff a daemon WS client subscribed to this runtime is connected. */
  online: boolean;
  capabilities: Record<string, unknown>;
  created_at: string;
}

export interface DaemonPanelEntry {
  id: string;
  device_name: string;
  external_id: string;
  /** ISO last_seen_at — when the daemon last hit /runtime/heartbeat. */
  last_seen_at: string | null;
  created_at: string;
  runtimes: RuntimePanelEntry[];
}

export interface RuntimesListResponse {
  ok: true;
  daemons: DaemonPanelEntry[];
}

// ── Work products — single deliverable detail ───────────────────────────────

export interface WorkProductDetail {
  id: string;
  task_id: string;
  task_short_id: string;
  task_title: string;
  agent_id: string;
  agent_label: string;
  type: WorkProductType;
  title: string;
  summary?: string;
  url?: string;
  provider?: string;
  external_id?: string;
  /**
   * Full deliverable content. Sourced from `work_product.body` when set;
   * otherwise falls back to reading a `file://` URL from disk. Truncated
   * to 256 KB.
   */
  body?: string;
  /** True when `url` is file:// — UI uses this to suppress an unclickable link. */
  url_is_local: boolean;
  created_at: string;
  updated_at: string;
}

// ── find_repo — candidate repos the discovery tool ranks ────────────────────
//
// Returned inside the `find_repo` tool envelope and surfaced verbatim by the
// capabilities page. Declared here rather than in `tools/find-repo.ts` so the
// server that scores candidates and the UI that renders them share one shape.

export type FindRepoSource = "learned" | "community" | "trending" | "github";

export interface FindRepoCandidate {
  repo_url: string;
  score: number;
  /** Highest-precedence source (learned > community > trending > github). */
  source: FindRepoSource;
  /** Every source that contributed to the score. Useful for debugging. */
  sources: FindRepoSource[];
  /** Human-readable explanation of why this candidate scored. */
  reason: string;
  /** GitHub stars when available (best-effort enrich). */
  stars?: number;
  /** GitHub description when available. */
  description?: string;
  /** Programming language inferred from GitHub. */
  language?: string;
  /** Hydrated learned_skill row when source includes "learned". */
  learned_skill?: {
    id: string;
    name: string;
    goal_pattern: string;
    invocation: string;
  };
}

// ── Re-exports of ambient types that web imports alongside the DTOs ─────────

export type { TaskStatus };
