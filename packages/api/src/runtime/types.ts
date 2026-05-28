/**
 * Wire types for the /runtime/* surface. Shared between the api server
 * (handlers in router.ts) and any daemon implementation (packages/daemon
 * lands in Phase 5). Kept in @beevibe/api for now; promote to a shared
 * package if more consumers need them.
 */

import type {
  HierarchyLevel,
  KnownCli,
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

/**
 * `POST /runtime/sync` — bv_d_ auth. Re-runs CLI detection on a daemon
 * that was already set up. Upserts runtimes against the caller's
 * daemon row (no `external_id` lookup — the bv_d_ already identifies
 * the daemon). Used by `beevibe-daemon sync` after the user installs
 * a new CLI without rotating the daemon's token.
 */
export interface RuntimeSyncRequest {
  runtimes: Array<{
    cli: string;
    cli_version?: string;
  }>;
}

export interface RuntimeSyncResponse {
  /** Full list of runtimes for this daemon after the upsert. */
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
  /**
   * Daemon-side: drives the tier filter for `<workspace>/.claude/skills/`
   * sync. Pulled from agent.hierarchy_level at claim time.
   */
  agent_hierarchy_level: HierarchyLevel;
  /** CLI runtime to spawn. Mirrors the claimed `session.runtime_id` when pinned. */
  runtime_type: KnownCli;
  intent: string;
  system_prompt_append: string;
  /** When set, daemon spawns with `--resume <cli_session_id>`. */
  resume_session_id?: string;
  model?: string;
  max_turns?: number;
  /**
   * Tool allowlist resolved from the agent's template
   * (see `resolveTemplateToolFlags`). Daemon passes through to
   * `claude --allowedTools <comma-joined>`. Universal platform tools
   * (update_progress, archival_memory_*, etc.) are already merged in by
   * the resolver — daemon does no further mutation.
   */
  allowed_tools?: readonly string[];
  /**
   * Tool denylist resolved from the agent's template. Daemon passes
   * through to `claude --disallowedTools <comma-joined>`. Universal
   * platform tools have already been stripped by the resolver.
   */
  disallowed_tools?: readonly string[];
  /** Session-scoped env vars; daemon merges with its own when spawning. */
  env: Record<string, string>;
  type: SessionType;
  /** /mcp endpoint daemon writes into mcp-config.json. */
  mcp_server_url: string;
  /**
   * Set when type === 'run_repo'. Tells the daemon to skip the normal
   * CLI runtime path and invoke @beevibe/sandbox's runRepoAgent inside
   * Docker. Capability Network (#149).
   */
  run_repo?: RunRepoDispatch;
}

export interface RunRepoDispatch {
  /** Pre-created repo_run row id; daemon reports back against it. */
  repo_run_id: string;
  /** GitHub repo the child agent should borrow. */
  repo_url: string;
  /** What the child agent is being asked to do, in plain language. */
  goal: string;
  /** Optional input file to pre-stage into the sandbox before the agent starts. */
  input_url?: string;
  input_filename?: string;
  /** Hard caps on the run. Daemon defaults apply when omitted. */
  limits?: {
    wall_clock_minutes?: number;
    max_install_attempts?: number;
    disk_mb?: number;
  };
}

/* ─── Skills sync ────────────────────────────────────────────────────── */

export interface RuntimeSkillFile {
  /** Path relative to the skill's directory, e.g. "SKILL.md" or "references/x.md". */
  path: string;
  content: string;
}

export interface RuntimeSkill {
  name: string;
  files: RuntimeSkillFile[];
}

export interface RuntimeSkillsResponse {
  /**
   * SHA-256 hex digest of all skill file contents. Daemons can short-
   * circuit re-download when the version matches their local cache.
   */
  version: string;
  skills: RuntimeSkill[];
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
  /**
   * Capability Network: when the dispatch was a run_repo, the daemon
   * reports the captured recipe + exported artifacts. The api creates
   * work_product rows from these and updates the repo_run row.
   */
  run_repo?: RunRepoDoneReport;
}

export interface RunRepoArtifact {
  /** Basename inside the daemon's sandbox artifact dir. */
  filename: string;
  /** Human-readable display title; falls back to filename. */
  title: string;
  size_bytes: number;
  /** Absolute path on the daemon's filesystem; the api reads from here when serving the artifact. */
  host_path: string;
  /** Original path inside the sandbox before export. */
  sandbox_path?: string;
}

export interface RunRepoDoneReport {
  repo_run_id: string;
  /** Resolved at clone time; pinned in any learned_skill captured from this run. */
  repo_ref?: string;
  /**
   * Concatenated successful install commands the child agent ran (e.g.
   * "pip install pdfplumber\n…"). Used as install_steps when the user
   * saves the run as a learned skill.
   */
  install_log?: string;
  /** Final command(s) that produced the artifact. Used as invocation in learned_skill. */
  invocation?: string;
  artifacts: RunRepoArtifact[];
}
