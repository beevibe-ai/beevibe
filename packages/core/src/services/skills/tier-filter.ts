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

export const UNIVERSAL_SKILLS = [
  "beevibe-mesh-ask-responder",
  "beevibe-post-blocker-revision",
  "beevibe-pre-task-setup",
  "beevibe-session-resume",
  "beevibe-work-product-decision",
] as const;

// Removed during M9.5 empirical validation (Skill auto-discovery doesn't fire
// for "always-on" triggers — body never loads, content is dead weight in
// system prompt). Each removed skill's load-bearing content moved to a
// system-prompt reminder injected by AgentSession via --append-system-prompt:
//   - `beevibe-task-completion` → BEEVIBE_LIFECYCLE_REMINDER (always call
//     update_progress before exit; leaf-vs-parent rule)
//   - `beevibe` (umbrella) → BEEVIBE_LIFECYCLE_REMINDER (identity guard +
//     session lifecycle); other umbrella content (tool surface, skill catalog)
//     is already provided by Claude Code's deferred-tool list and
//     auto-discovered <skill_listing> attachment respectively
//   - `beevibe-memory-management` → BEEVIBE_MEMORY_REMINDER (Letta pattern:
//     active mid-session memory updates driven by system prompt + tool
//     descriptions, not by skill descriptions which agents don't auto-load
//     for continuous behaviors)

export const TEAM_ONLY_SKILLS = [
  "beevibe-team-mesh-negotiation",
  "beevibe-team-mesh-tool-choice",
  "beevibe-team-task-creation",
] as const;

/**
 * Resolve a tier to its skill membership set. Returns a fresh Set each call
 * so callers can mutate / check freely without affecting the source.
 */
export function tierFilterFor(level: HierarchyLevel): Set<string> {
  if (level === "ic") return new Set(UNIVERSAL_SKILLS);
  return new Set([...UNIVERSAL_SKILLS, ...TEAM_ONLY_SKILLS]);
}
