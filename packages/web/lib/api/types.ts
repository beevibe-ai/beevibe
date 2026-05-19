/**
 * Web-side re-exports of the read-DTO contract owned by `@beevibe/api`.
 *
 * Live shapes are defined in `packages/api/src/views/types.ts` so the
 * backend is the single source of truth for the read surface.
 */

export type {
  TaskDetail,
  TaskDetailSessionRow,
  AgentDetail,
  AgentDisplay,
  DashboardSummary,
  MeshOverview,
} from "@beevibe/api/views/types";
