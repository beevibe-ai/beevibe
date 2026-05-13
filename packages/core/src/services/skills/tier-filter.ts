/**
 * Tier filter for skill sync (M9.2).
 *
 * Per-tier skill membership map. Universal skills are loaded for every
 * agent; team-only skills only for team/org tier. Naming convention:
 * `beevibe-team-*` for team-only so universal skills sort before them
 * alphabetically — keeps the cross-tier prefix stable in Claude Code's
 * auto-discovered skill metadata block (cache-friendly per Claude Code's
 * own engineering guidance on prompt caching).
 */

import type { HierarchyLevel } from "../../domain/agent.js";

export const UNIVERSAL_SKILLS = ["beevibe-pre-task-setup"] as const;

export const TEAM_ONLY_SKILLS = ["beevibe-team-mesh-negotiation"] as const;

// Skills culled during M9 empirical validation. The Letta pattern won out:
// behavioral rules that fire CONTINUOUSLY or under generic triggers belong in
// the system prompt or tool descriptions, not in skill descriptions (Claude
// Code's auto-discovery is selector-only — bodies don't auto-load for vague
// triggers, and "always-on" rules in skill bodies are dead weight). Skills
// survive only when they encode HOW to do something deeply procedural, once
// the agent has DECIDED to do it (e.g., git workspace setup, multi-round
// negotiation protocol).
//
//   - `beevibe` (umbrella) + `beevibe-task-completion` → BEEVIBE_LIFECYCLE_REMINDER_TASK
//     (always call update_progress; leaf-vs-parent rule; deliverable handling)
//   - `beevibe-memory-management` → BEEVIBE_MEMORY_REMINDER (active
//     mid-session memory writeback)
//   - `beevibe-mesh-ask-responder` → coverage by intent-block guidance from
//     the mesh server (the spawn intent already carries `respond_ask` directive)
//   - `beevibe-session-resume` + `beevibe-post-blocker-revision` → covered
//     by Claude Code's `--resume` mechanism (the executor dispatches the
//     revision/post-escalation session with --resume on the prior cli_session_id,
//     so the agent's conversation history already shows the worktree cd and
//     prior tool calls; no re-orientation skill needed). Empirically validated
//     in m9-e2e scenario 14: zero session-resume invocations, worktree reused
//     correctly on revision dispatch.
//   - `beevibe-work-product-decision` → BEEVIBE_LIFECYCLE_REMINDER_TASK (call
//     list_work_products first to dedupe) + work-product MCP tool descriptions
//   - `beevibe-team-mesh-tool-choice` → coverage by tool descriptions (each
//     mesh tool's description already says when to use it vs alternatives)
//   - `beevibe-team-task-creation` → moved into the create_task tool
//     description (title style, description style, no-fit → report_blocker)

/**
 * Resolve a tier to its skill membership set. Returns a fresh Set each call
 * so callers can mutate / check freely without affecting the source.
 */
export function tierFilterFor(level: HierarchyLevel): Set<string> {
  if (level === "ic") return new Set(UNIVERSAL_SKILLS);
  return new Set([...UNIVERSAL_SKILLS, ...TEAM_ONLY_SKILLS]);
}
