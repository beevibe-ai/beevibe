/**
 * Web-side re-exports of the read-DTO contract owned by `@beevibe/api`.
 *
 * Live shapes are defined in `packages/api/src/views/types.ts` so the
 * backend is the single source of truth for the read surface.
 */

export type {
  // Route-level wire DTOs. These used to be hand-copied into
  // `client.ts`; the copies had drifted (the runtime panel typed
  // `cli_version` / `last_heartbeat` as optional strings where the
  // server sends `string | null`), which is the failure mode this
  // module exists to prevent.
  WorkProductDetail,
  RoomMessageDetail,
  RuntimePanelEntry,
  DaemonPanelEntry,
  RuntimesListResponse,
  TaskDetail,
  TaskDetailSessionRow,
  AgentDetail,
  AgentDisplay,
  DashboardSummary,
  MeshOverview,
  MemoryActivitySummary,
  MemoryActivityKpis,
  WeeklyArchivalRow,
  ScopeTypeRow,
  AgentActivityRow,
  DormantAgentRow,
  CoreSnapshotRow,
  AgentRatioRow,
  BeforeAfterData,
} from "@beevibe/api/views/types";
