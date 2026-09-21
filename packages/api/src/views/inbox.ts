/**
 * Inbox view — items this human owes a decision on. The Home page's
 * sidebar binds against this; the dashboard widgets answer "what's
 * happening" and Recent Activity firehose'd everything, but a working
 * human's actual question is "what needs me right now?"
 *
 * Three sources, all from existing tables (no schema additions):
 *   1. tasks in `review` status the caller created — team finished,
 *      awaits human approval (TaskService gates `done` on review_policy)
 *   2. tasks in `blocked` status the caller created — their work hit a
 *      wall and someone needs to unblock it
 *   3. pending escalations involving the caller's agents — two
 *      specialists couldn't agree across N rounds, want a human call
 *
 * One UNION ALL query. Sorted by `age_at DESC` so the freshest demand
 * is on top. Caller is identified by `personId` (humans only); the
 * route handler enforces that upstream.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import { TASK_ACTOR_JOINS, taskOwnerScopeSql } from "./task-scope.js";
import type { InboxItem, InboxItemKind } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TITLE_TRUNCATE = 120;

/**
 * Branches 1 + 2 — tasks awaiting the caller's review/unblock decision.
 *
 * The two differ only in the status they select and the `detail` line
 * they show, so one template generates both. Written out twice they
 * were 15 near-identical lines apiece, including a verbatim copy of the
 * owner-scope predicate — and a change to one arm that missed the other
 * would silently make the inbox's two halves disagree about which tasks
 * the caller can see.
 *
 * Scoping is `taskOwnerScopeSql`, the same rule the `/task` list uses
 * (see views/task-scope.ts).
 *
 * The select list is no longer column-aligned the way the two
 * hand-written branches were: `detail` varies in width between them, so
 * there is no padding that lines both up. Keeping the generated SQL
 * readable in logs is what `indent` is for — a multi-line fragment
 * pasted into an indented position would otherwise land ragged.
 */
function indent(fragment: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return fragment.split("\n").join(`\n${pad}`);
}

function taskBranchSql(
  kind: "task_review" | "task_blocked",
  status: "review" | "blocked",
  detail: string,
): string {
  return /* sql */ `
  SELECT
    '${kind}:' || t.id AS id,
    '${kind}'::text AS kind,
    LEFT(t.title, ${TITLE_TRUNCATE}) AS title,
    ${detail} AS detail,
    '/tasks/' || t.id AS href,
    t.updated_at AS age_at
  FROM task t
  ${indent(TASK_ACTOR_JOINS, 2)}
  WHERE t.status = '${status}'
    AND ${indent(taskOwnerScopeSql("$1"), 4)}`;
}

/**
 * One UNION ALL query covers all three sources. Each branch yields
 * the same column set (id / kind / title / detail / href / age_at)
 * so the application layer maps a uniform row shape to InboxItem.
 *
 * Branches 1 + 2 — see `taskBranchSql` above. Humans don't create tasks
 *   directly — the `create_task` MCP tool stamps `creator_type='agent'`
 *   — so a `creator_type='person' AND creator_id=$1` filter (which is
 *   what this query used to do) misses every real task in the system.
 *
 * Branch 3 — escalations awaiting a human resolver. Walked from
 *   negotiation → both agents to find any owned by the caller; one
 *   row per escalation regardless of which side the caller owns.
 *   Its own scope rule: escalations hang off a negotiation, not a
 *   task, so `taskOwnerScopeSql` doesn't apply.
 */
const LIST_SQL = /* sql */ `
WITH inbox AS (
${taskBranchSql("task_review", "review", `COALESCE(asg.name, '(unassigned)')`)}

  UNION ALL
${taskBranchSql(
  "task_blocked",
  "blocked",
  `COALESCE(t.blocker_reason, 'Blocked — no reason given')`,
)}

  UNION ALL

  SELECT
    'escalation_pending:' || e.id            AS id,
    'escalation_pending'::text               AS kind,
    LEFT(e.summary, ${TITLE_TRUNCATE})       AS title,
    ai.name || ' ↔ ' || ac.name              AS detail,
    '/escalations/' || e.id                  AS href,
    e.created_at                             AS age_at
  FROM escalation e
  JOIN negotiation n ON n.id = e.negotiation_id
  JOIN agent ai ON ai.id = n.initiator_agent_id
  JOIN agent ac ON ac.id = n.counterparty_agent_id
  WHERE e.status = 'pending'
    AND (ai.owner_id = $1 OR ac.owner_id = $1)
)
SELECT id, kind, title, detail, href, age_at
FROM inbox
ORDER BY age_at DESC
LIMIT $2
`;

interface InboxRow {
  id: string;
  kind: InboxItemKind;
  title: string;
  detail: string;
  href: string;
  age_at: Date;
}

export interface InboxFilter {
  /** Default 50, clamped 1..200. */
  limit?: number;
}

export async function listInbox(
  pool: Pool,
  personId: string,
  filter: InboxFilter = {},
): Promise<InboxItem[]> {
  const limit = Math.min(
    Math.max(1, filter.limit ?? DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const { rows } = await pool.query<InboxRow>(LIST_SQL, [personId, limit]);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    href: row.href,
    age_at: row.age_at,
  }));
}
