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
  "beevibe",
  "beevibe-memory-management",
  "beevibe-mesh-ask-responder",
  "beevibe-post-blocker-revision",
  "beevibe-pre-task-setup",
  "beevibe-session-resume",
  "beevibe-task-completion",
  "beevibe-work-product-decision",
] as const;

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
