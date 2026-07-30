import type { HierarchyLevel } from "./agent.js";

export interface CoreMemoryBlock {
  id: string;
  agent_id: string;
  block_name: string;
  content: string;
  char_limit: number;
  description: string;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

export const TOTAL_BLOCK_CHAR_LIMIT = 50_000;

/**
 * Blocks consulted when deciding whether to route a request to a peer/sub
 * (i.e., "does this agent know about X?"). Per-tier subset.
 */
export const ROUTING_BLOCKS: Record<HierarchyLevel, readonly string[]> = {
  ic: ["persona", "domain"],
  team: ["persona", "team_members"],
  org: ["persona", "teams"],
};

export interface BlockTemplate {
  block_name: string;
  char_limit: number;
  is_system: boolean;
  initial_content: string;
  /**
   * First-person guidance ("Who I am…", "What I'm currently working on…")
   * that the agent reads to decide HOW and WHEN to update this block.
   * Per Letta's pattern: the description is the single source of truth for
   * the block's purpose, and is surfaced to the agent in three places:
   *   1. As an attribute on the `<core_memory>` XML in the system prompt
   *   2. As the `block_name` enum's per-value guidance on `update_core_memory`
   *   3. As field descriptions on `create_subordinate_agent` for the parent
   * Keep these in sync — they're all read by the same agent at different
   * moments in the same session.
   */
  description: string;
}

/**
 * Core memory blocks per hierarchy tier. Each block has a narrow,
 * non-overlapping purpose; the description is what tells the agent which
 * content belongs where.
 *
 * Framing: agents are persistent SPECIALISTS, not project-bound. The
 * stable identity (persona, domain, tag_line) survives across every
 * project they touch. Project context (active_context, active_work) is
 * transient and gets rewritten when the agent shifts to a new codebase.
 *
 * THIS CONSTANT IS THE SOURCE OF TRUTH for block descriptions. New
 * agents inherit descriptions via `coreMemoryRepo.initDefaults` (which
 * reads this constant). To propagate description edits to EXISTING
 * agents, run `pnpm sync-core-memory` — that script re-runs initDefaults
 * per agent, and `ON CONFLICT` updates the description column to the
 * latest template value. The migration's initial backfill is a snapshot
 * that may drift if the template is edited later; the sync script is
 * how we reconcile.
 */
export const DEFAULT_BLOCK_TEMPLATES: Record<HierarchyLevel, readonly BlockTemplate[]> = {
  ic: [
    {
      block_name: "tag_line",
      char_limit: 100,
      is_system: true,
      initial_content: "",
      description:
        "One-line headline of my enduring specialization — shown on agent " +
        "cards in the UI. Describes what I'm an expert in, not what " +
        "project I'm currently on. Examples: 'Go backend specialist " +
        "(Chi/sqlc, websockets)', 'Next.js + React UI lead'. Max 100 " +
        "chars. Update only when my specialization itself shifts.",
    },
    {
      block_name: "persona",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "Who I am and how I work — my role and working style, persistent " +
        "across every project I touch. 1-3 sentences in first person. " +
        "Update when my self-conception genuinely shifts (acquired a " +
        "major capability, refined my approach). NOT my current project " +
        "(that's `active_context`), NOT my domain scope (that's `domain`).",
    },
    {
      block_name: "domain",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "The areas I specialize in ACROSS all projects — my enduring " +
        "expertise. As I work on more projects in my domain, this can " +
        "deepen (becoming truly expert in narrower sub-areas). Bullet " +
        "format. Example: 'Go backend services: HTTP via Chi/echo, DB " +
        "via sqlc, websockets via gorilla, distribution via goreleaser.' " +
        "NOT project-specific paths (those go in `active_context`). NOT " +
        "the rules I follow (those go in `constraints`).",
    },
    {
      block_name: "active_context",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "What I'm currently working on — the specific project and its " +
        "in-flight details. Bullet format. Example: 'Project: " +
        "github.com/multica-ai/multica. Local clone: /tmp/multica-repo. " +
        "Owned paths in this project: server/cmd/**, server/internal/**. " +
        "Current task: task_xfQpuEHWjbvk.' Transient — rewrite when the " +
        "project changes. This is where ALL project/codebase-specific " +
        "details live, NOT in `domain`.",
    },
    {
      block_name: "constraints",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "Hard rules I follow — non-negotiable conventions and " +
        "coordination boundaries. Mix of persistent rules ('queries " +
        "always via sqlc — never hand-write the DB layer') and " +
        "project-specific rules ('read /CLAUDE.md before changes in " +
        "this codebase'). Bullet format. Reference docs by path, not " +
        "content.",
    },
  ],
  team: [
    {
      block_name: "tag_line",
      char_limit: 100,
      is_system: true,
      initial_content: "",
      description:
        "One-line headline of my enduring role — shown on agent cards. " +
        "Describes the team I lead, not the project we're on. Examples: " +
        "'Daniel's team — orchestrates 3 backend/frontend/platform " +
        "specialists', 'Solo lead — driving a small team for hire'. " +
        "Max 100 chars.",
    },
    {
      block_name: "persona",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "Who I am as a team lead — my orchestration style and how I " +
        "delegate. 1-3 sentences in first person. Persistent across " +
        "projects. NOT my team roster (that's `team_members`), NOT the " +
        "current work (that's `active_work`).",
    },
    {
      block_name: "team_members",
      char_limit: 3000,
      is_system: true,
      initial_content: "",
      description:
        "Roster of my direct reports — for each: name, agent_id, " +
        "specialization (NOT project assignment — same agents stay over " +
        "time as we work different projects). Bullet format. Update " +
        "when subordinates are spawned/archived/reassigned.",
    },
    {
      block_name: "active_work",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "What my team is currently working on — the active project + " +
        "high-level work in flight across specialists. Bullet format. " +
        "Example: 'Project: github.com/multica-ai/multica. Backend " +
        "specialist running CLI audit (task_xfQpuEHWjbvk); Frontend on " +
        "standby.' Transient — rewrite on project shifts.",
    },
    {
      block_name: "patterns",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "Cross-project patterns I've observed in how my team operates — " +
        "what works, what trips them up. Persistent. Example: 'When I " +
        "assign an audit task, the IC tends to produce thorough work " +
        "products but forgets to save_memory mid-pass.' NOT specific " +
        "findings about a codebase (those go in archival memory via " +
        "save_memory).",
    },
  ],
  org: [
    {
      block_name: "tag_line",
      char_limit: 100,
      is_system: true,
      initial_content: "",
      description:
        "One-line headline of my org-level role — shown on agent cards. " +
        "Describes the scope I oversee, not the current project. " +
        "Examples: 'Eng org lead — 3 teams (product/platform/infra)'. " +
        "Max 100 chars.",
    },
    {
      block_name: "persona",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "Who I am as an org leader — my decision style and how I balance " +
        "across teams. 1-3 sentences. Persistent.",
    },
    {
      block_name: "teams",
      char_limit: 3000,
      is_system: true,
      initial_content: "",
      description:
        "Teams under my oversight — for each: name, team-lead agent_id, " +
        "scope. Persistent identity. Bullet format.",
    },
    {
      block_name: "strategy",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "Cross-project / cross-team direction I'm driving. Higher-level " +
        "than active_work. Examples: 'Q2 focus: ship Multica self-host " +
        "v1', 'Hiring: prioritize backend over frontend this quarter'.",
    },
    {
      block_name: "decisions",
      char_limit: 2000,
      is_system: true,
      initial_content: "",
      description:
        "Cross-team decisions I've resolved — bullet log. Each entry: " +
        "what was decided, when, why. Persistent record so the same " +
        "question doesn't come back up.",
    },
  ],
};
