/**
 * Task views — read-only composers that produce `TaskListItem` / `TaskDetail`
 * DTOs from raw SQL. Talks directly to `pg.Pool` and never touches core's
 * repos or services — denormalization (assignee_label, creator_label,
 * latest_session, session_count, work_product_count) lives in SQL JOINs so
 * the page renders in one round-trip.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { Lifecycle } from "./tasks-grouping.js";
import {
  TASK_STATUSES_BY_LIFECYCLE,
  TASK_STATUSES_BY_VIEW,
} from "./tasks-grouping.js";
import { deriveShortId, formatDurationLabel } from "./format.js";
import type {
  TaskListItem,
  TaskDetail,
  TaskDetailSessionRow,
  TaskLatestSessionSummary,
} from "./types.js";
import type {
  HierarchyLevel,
  SessionStatus,
  Task,
  TaskPriority,
  TaskStatus,
  WorkProduct,
  CreatorType,
} from "@beevibe/core";

export interface TaskListFilter {
  lifecycle?: Lifecycle;
  assignee_id?: string;
  /**
   * Saved-view shortcut. "mine" needs the caller's personId — the route
   * resolves that to the caller's primary agent's task assignments and
   * passes it as `assignee_id` instead. "sprint" maps to a status set; see
   * tasks-grouping.ts.
   */
  view?: "all" | "mine" | "sprint" | "timeline";
  /**
   * Caller's person id — the list is scoped to tasks where the caller
   * owns the assignee agent, owns the creator agent, or created the task
   * directly. Required unless `bypassOwnerScope` is set.
   */
  caller_person_id?: string;
  /**
   * Test/admin escape hatch — explicitly opt out of owner-scope
   * filtering. The runtime guard in `listTasks` enforces that one of
   * `caller_person_id` or `bypassOwnerScope` is set, so production
   * callers can't silently leak by forgetting the scope.
   */
  bypassOwnerScope?: true;
}

interface TaskListRow {
  // task.*
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  creator_id: string;
  creator_type: CreatorType;
  parent_task_id: string | null;
  result_summary: string | null;
  blocker_agent_id: string | null;
  blocker_reason: string | null;
  repo_url: string | null;
  next_dispatch_context: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  // joins
  assignee_name: string | null;
  assignee_hier: HierarchyLevel | null;
  creator_label: string | null;
  session_count: string;
  work_product_count: string;
  latest_session_id: string | null;
  latest_session_status: SessionStatus | null;
  latest_session_started_at: Date | null;
  latest_session_completed_at: Date | null;
  latest_session_agent_label: string | null;
}

const LIST_SQL = /* sql */ `
WITH latest_session AS (
  SELECT DISTINCT ON (s.task_id)
    s.task_id,
    s.id           AS sid,
    s.status       AS sstatus,
    s.started_at   AS sstarted,
    s.completed_at AS scompleted,
    a.name         AS agent_label
  FROM session s
  JOIN agent a ON a.id = s.agent_id
  WHERE s.task_id IS NOT NULL
  ORDER BY s.task_id, s.created_at DESC
),
session_counts AS (
  SELECT task_id, COUNT(*)::int AS n
  FROM session
  WHERE task_id IS NOT NULL
  GROUP BY task_id
),
wp_counts AS (
  SELECT task_id, COUNT(*)::int AS n
  FROM work_product
  GROUP BY task_id
)
SELECT
  t.*,
  asg.name              AS assignee_name,
  asg.hierarchy_level   AS assignee_hier,
  COALESCE(crt_a.name, crt_p.name) AS creator_label,
  COALESCE(sc.n, 0)     AS session_count,
  COALESCE(wpc.n, 0)    AS work_product_count,
  ls.sid                AS latest_session_id,
  ls.sstatus            AS latest_session_status,
  ls.sstarted           AS latest_session_started_at,
  ls.scompleted         AS latest_session_completed_at,
  ls.agent_label        AS latest_session_agent_label
FROM task t
LEFT JOIN agent  asg   ON asg.id   = t.assignee_id
LEFT JOIN agent  crt_a ON crt_a.id = t.creator_id  AND t.creator_type = 'agent'
LEFT JOIN person crt_p ON crt_p.id = t.creator_id  AND t.creator_type = 'person'
LEFT JOIN session_counts sc ON sc.task_id = t.id
LEFT JOIN wp_counts wpc     ON wpc.task_id = t.id
LEFT JOIN latest_session ls ON ls.task_id = t.id
WHERE ($1::text[] IS NULL OR t.status = ANY($1::text[]))
  AND ($2::text   IS NULL OR t.assignee_id = $2)
  AND (
    $3::text IS NULL
    OR asg.owner_id = $3
    OR crt_a.owner_id = $3
    OR (t.creator_type = 'person' AND t.creator_id = $3)
  )
ORDER BY t.created_at DESC
`;

/**
 * Resolve the lifecycle/view filter to the actual statuses the SQL needs.
 * Returns `null` when no filter (all statuses).
 */
function resolveStatusFilter(
  filter: TaskListFilter,
): readonly TaskStatus[] | null {
  if (filter.lifecycle) return TASK_STATUSES_BY_LIFECYCLE[filter.lifecycle];
  if (filter.view && filter.view !== "all" && filter.view !== "mine") {
    return TASK_STATUSES_BY_VIEW[filter.view] ?? null;
  }
  return null;
}

function rowToTaskListItem(row: TaskListRow): TaskListItem {
  const latest_session: TaskLatestSessionSummary | undefined =
    row.latest_session_id && row.latest_session_status
      ? {
          short_id: deriveShortId(row.latest_session_id),
          status: row.latest_session_status,
          elapsed: formatDurationLabel(
            row.latest_session_started_at,
            row.latest_session_completed_at,
          ),
          agent_label: row.latest_session_agent_label ?? "agent",
        }
      : undefined;

  const item: TaskListItem = {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee_id: row.assignee_id ?? undefined,
    creator_id: row.creator_id,
    creator_type: row.creator_type,
    parent_task_id: row.parent_task_id ?? undefined,
    blocker_agent_id: row.blocker_agent_id ?? undefined,
    blocker_reason: row.blocker_reason ?? undefined,
    repo_url: row.repo_url ?? undefined,
    next_dispatch_context: row.next_dispatch_context as Task["next_dispatch_context"],
    created_at: row.created_at,
    updated_at: row.updated_at,
    assignee_hierarchy: row.assignee_hier ?? undefined,
    assignee_label: row.assignee_name ?? undefined,
    creator_label: row.creator_label ?? undefined,
    description: row.description ? [row.description] : undefined,
    result_summary: row.result_summary ?? undefined,
    session_count: Number(row.session_count),
    work_product_count: Number(row.work_product_count),
    latest_session,
  };
  return item;
}

export async function listTasks(
  pool: Pool,
  filter: TaskListFilter = {},
): Promise<TaskListItem[]> {
  if (!filter.caller_person_id && !filter.bypassOwnerScope) {
    throw new Error(
      "listTasks requires caller_person_id (or bypassOwnerScope for tests/admin tooling)",
    );
  }
  const statuses = resolveStatusFilter(filter);
  const { rows } = await pool.query<TaskListRow>(LIST_SQL, [
    statuses ? [...statuses] : null,
    filter.assignee_id ?? null,
    filter.caller_person_id ?? null,
  ]);
  return rows.map(rowToTaskListItem);
}

interface DetailSessionRow {
  id: string;
  agent_id: string;
  agent_label: string;
  status: SessionStatus;
  started_at: Date | null;
  completed_at: Date | null;
  result_summary: string | null;
}

const DETAIL_SQL_TASK = /* sql */ `
WITH latest_session AS (
  SELECT DISTINCT ON (s.task_id)
    s.task_id, s.id AS sid, s.status AS sstatus, s.started_at AS sstarted,
    s.completed_at AS scompleted, a.name AS agent_label
  FROM session s
  JOIN agent a ON a.id = s.agent_id
  WHERE s.task_id = $1
  ORDER BY s.task_id, s.created_at DESC
)
SELECT
  t.*,
  asg.name              AS assignee_name,
  asg.hierarchy_level   AS assignee_hier,
  COALESCE(crt_a.name, crt_p.name) AS creator_label,
  (SELECT COUNT(*) FROM session       WHERE task_id = t.id)::int AS session_count,
  (SELECT COUNT(*) FROM work_product  WHERE task_id = t.id)::int AS work_product_count,
  ls.sid                AS latest_session_id,
  ls.sstatus            AS latest_session_status,
  ls.sstarted           AS latest_session_started_at,
  ls.scompleted         AS latest_session_completed_at,
  ls.agent_label        AS latest_session_agent_label
FROM task t
LEFT JOIN agent  asg   ON asg.id   = t.assignee_id
LEFT JOIN agent  crt_a ON crt_a.id = t.creator_id  AND t.creator_type = 'agent'
LEFT JOIN person crt_p ON crt_p.id = t.creator_id  AND t.creator_type = 'person'
LEFT JOIN latest_session ls ON ls.task_id = t.id
WHERE t.id = $1
LIMIT 1
`;

const DETAIL_SQL_SESSIONS = /* sql */ `
SELECT
  s.id, s.agent_id, a.name AS agent_label, s.status,
  s.started_at, s.completed_at, s.result_summary
FROM session s
JOIN agent a ON a.id = s.agent_id
WHERE s.task_id = $1
ORDER BY s.created_at DESC
`;

const DETAIL_SQL_WORK_PRODUCTS = /* sql */ `
SELECT * FROM work_product WHERE task_id = $1 ORDER BY created_at DESC
`;

export async function getTask(
  pool: Pool,
  id: string,
): Promise<TaskDetail | undefined> {
  const [taskResult, sessionResult, wpResult] = await Promise.all([
    pool.query<TaskListRow>(DETAIL_SQL_TASK, [id]),
    pool.query<DetailSessionRow>(DETAIL_SQL_SESSIONS, [id]),
    pool.query(DETAIL_SQL_WORK_PRODUCTS, [id]),
  ]);
  const taskRow = taskResult.rows[0];
  if (!taskRow) return undefined;

  const sessions: TaskDetailSessionRow[] = sessionResult.rows.map((s) => ({
    id: s.id,
    short_id: deriveShortId(s.id),
    agent_id: s.agent_id,
    agent_label: s.agent_label,
    status: s.status,
    started_at: s.started_at ?? new Date(0),
    duration_label: formatDurationLabel(s.started_at, s.completed_at),
    result_summary: s.result_summary ?? undefined,
  }));

  const work_products: WorkProduct[] = wpResult.rows.map(rowToWorkProduct);

  return {
    ...rowToTaskListItem(taskRow),
    sessions,
    work_products,
  };
}

function rowToWorkProduct(r: Record<string, unknown>): WorkProduct {
  return {
    id: String(r.id),
    task_id: String(r.task_id),
    agent_id: String(r.agent_id),
    type: r.type as WorkProduct["type"],
    title: String(r.title),
    summary: (r.summary as string | null) ?? undefined,
    body: (r.body as string | null) ?? undefined,
    url: (r.url as string | null) ?? undefined,
    provider: (r.provider as string | null) ?? undefined,
    external_id: (r.external_id as string | null) ?? undefined,
    metadata: (r.metadata as Record<string, unknown> | null) ?? undefined,
    created_at: r.created_at as Date,
    updated_at: r.updated_at as Date,
  };
}
