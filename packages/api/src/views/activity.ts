/**
 * Activity feed — recent sessions across the caller's agents (team +
 * subordinates), surfaced as a chronological list for the chat
 * surface's live "what's happening" panel.
 *
 * Scope: anything `agent.owner_id = $1` runs through. Joins agent name
 * for display, derives a kind from session.type (chat/task/mesh_ask/
 * blocker/negotiate), and includes the task title when there's a
 * linked task so we can show "running task: refactor auth flow"
 * style entries.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { HierarchyLevel, SessionStatus, SessionType } from "@beevibe/core";
import { deriveShortId, formatDurationLabel } from "./format.js";

export interface ActivityEntry {
  id: string;
  short_id: string;
  agent_id: string;
  agent_label: string;
  agent_hierarchy: HierarchyLevel;
  type: SessionType;
  status: SessionStatus;
  /** First line of intent (user message for chat / task title for task). */
  intent: string;
  task_id: string | null;
  task_title: string | null;
  task_short_id: string | null;
  started_at: string;
  duration_label: string;
}

interface ActivityRow {
  id: string;
  agent_id: string;
  agent_label: string;
  agent_hierarchy: HierarchyLevel;
  type: SessionType;
  status: SessionStatus;
  intent: string;
  task_id: string | null;
  task_title: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

const LIST_SQL = /* sql */ `
SELECT
  s.id,
  s.agent_id,
  a.name              AS agent_label,
  a.hierarchy_level   AS agent_hierarchy,
  s.type,
  s.status,
  s.intent,
  s.task_id,
  t.title             AS task_title,
  s.started_at,
  s.completed_at
FROM session s
JOIN agent a ON a.id = s.agent_id
LEFT JOIN task t ON t.id = s.task_id
WHERE a.owner_id = $1
ORDER BY COALESCE(s.started_at, s.created_at) DESC
LIMIT $2
`;

export async function listActivity(
  pool: Pool,
  ownerId: string,
  limit = 20,
): Promise<ActivityEntry[]> {
  const { rows } = await pool.query<ActivityRow>(LIST_SQL, [ownerId, limit]);
  return rows.map((row) => ({
    id: row.id,
    short_id: deriveShortId(row.id),
    agent_id: row.agent_id,
    agent_label: row.agent_label,
    agent_hierarchy: row.agent_hierarchy,
    type: row.type,
    status: row.status,
    intent: row.intent,
    task_id: row.task_id,
    task_title: row.task_title,
    task_short_id: row.task_id ? deriveShortId(row.task_id) : null,
    started_at: (row.started_at ?? new Date(0)).toISOString(),
    duration_label: formatDurationLabel(row.started_at, row.completed_at),
  }));
}
