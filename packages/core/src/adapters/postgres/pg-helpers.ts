export interface PatchClause {
  /** `"col = $N"` fragments for the SET clause */
  fields: string[];
  /** Values to bind in order of fields */
  values: unknown[];
  /** Next parameter index ($N) for a trailing WHERE binding */
  nextIndex: number;
}

/**
 * Build a SET-clause fragment for a partial-update query. Keys whose value is
 * `undefined` are skipped (treated as "don't touch"); all other values —
 * including explicit `null` — are included. Typical usage:
 *
 * ```ts
 * const clause = buildPatchClause(patch, { name: "name", owner_id: "owner_id" });
 * if (clause.fields.length === 0) return findExisting();
 * clause.fields.push(`updated_at = NOW()`);
 * await pool.query(
 *   `UPDATE t SET ${clause.fields.join(", ")} WHERE id = $${clause.nextIndex} RETURNING *`,
 *   [...clause.values, id],
 * );
 * ```
 */
export function buildPatchClause<T extends object>(
  patch: Partial<T>,
  columnMap: Partial<Record<keyof T, string>>,
): PatchClause {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, col] of Object.entries(columnMap) as Array<[keyof T, string]>) {
    const val = patch[key];
    if (val !== undefined) {
      fields.push(`${col} = $${i++}`);
      values.push(val);
    }
  }
  return { fields, values, nextIndex: i };
}

/**
 * SQL fragment ranking task.priority numerically (critical=4, high=3,
 * medium=2, low=1, unknown/NULL=0). TEXT alphabetical DESC orders
 * 'low' > 'high' > 'critical' (backwards), so ORDER BY clauses on
 * priority need this numeric expression instead.
 *
 * Pass `priority` for bare-column refs (task-repo `listAssignable`),
 * or `t.priority` when joined with a task alias (session-repo claim).
 *
 * Mirror of `migrations/1777500000000_fix-task-dispatch-index.sql`'s
 * partial-index CASE — the index uses the same numeric ranks, so the
 * planner can match queries that ORDER BY this expression. If you
 * change the numbers here, change them in that migration too.
 */
export function taskPriorityRankSql(column: string): string {
  return `(CASE ${column}
            WHEN 'critical' THEN 4
            WHEN 'high'     THEN 3
            WHEN 'medium'   THEN 2
            WHEN 'low'      THEN 1
            ELSE 0
          END)`;
}
