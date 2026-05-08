import type { HierarchyLevel } from "../domain/agent.js";

/**
 * The identity resolved from a bv_ API key.
 *
 * `source` tells downstream code (MCP server, executor, daemon endpoints)
 * what kind of caller this is:
 *   - "human"  → user ran `claude` themselves; no system-prompt arg was passed.
 *                MCP server must return the briefing as `instructions`.
 *   - "agent"  → session was spawned by an executor/mesh; the briefing is
 *                already in the CLI's system prompt via --append-system-prompt,
 *                so MCP server skips `instructions` to avoid duplication.
 *   - "daemon" → on-machine beevibe-daemon authenticating to /runtime/*
 *                endpoints. No agent identity; daemons claim sessions on
 *                behalf of any agent owned by `ownerPersonId`.
 */
export type ResolvedCaller =
  | {
      source: "agent";
      agentId: string;
      hierarchyLevel: HierarchyLevel;
    }
  | {
      source: "human";
      agentId: string;
      hierarchyLevel: HierarchyLevel;
      personId: string;
    }
  | {
      source: "daemon";
      daemonId: string;
      ownerPersonId: string;
    };
