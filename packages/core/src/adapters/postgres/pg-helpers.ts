import type { Pool, QueryResultRow } from "./client.js";

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
 *
 * Most repositories don't call this directly — `updateRowById` wraps the
 * whole sequence above. Reach for `buildPatchClause` when the UPDATE needs
 * something extra (a compound WHERE, a non-`id` key, an extra SET fragment).
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
 * Fetch a single row by primary key and map it into its domain type, or
 * `undefined` when there is no such row. Every repository's `findById` is
 * this query; `table` is always a literal from this package, never caller
 * input, so interpolating it is safe.
 */
export async function findRowById<Row extends QueryResultRow, T>(
  pool: Pool,
  table: string,
  id: string,
  map: (row: Row) => T,
): Promise<T | undefined> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM ${table} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? map(rows[0]) : undefined;
}

export interface UpdateRowOptions<Row extends QueryResultRow, Patch extends object, T> {
  pool: Pool;
  /** Table name — a literal from this package, interpolated into the SQL. */
  table: string;
  id: string;
  patch: Patch;
  /** Patch key → column name, as taken by `buildPatchClause`. */
  columns: Partial<Record<keyof Patch, string>>;
  map: (row: Row) => T;
  /**
   * Message for the "row doesn't exist" Error. Per-table because the
   * existing wording is not uniform (`Agent not found: x` vs
   * `daemon x not found`) and tests assert on it.
   */
  notFound: (id: string) => string;
  /** Append `updated_at = NOW()` to the SET clause. Default true. */
  touchUpdatedAt?: boolean;
}

/**
 * Partial-update a row by primary key and return the updated domain object.
 *
 * An all-`undefined` patch produces no SET fragments; rather than emit
 * invalid SQL, that case degrades to a read — which still throws if the row
 * is gone, so `update` never silently reports success for a missing id.
 */
export async function updateRowById<Row extends QueryResultRow, Patch extends object, T>(
  opts: UpdateRowOptions<Row, Patch, T>,
): Promise<T> {
  const clause = buildPatchClause<Patch>(opts.patch, opts.columns);

  if (clause.fields.length === 0) {
    const existing = await findRowById<Row, T>(opts.pool, opts.table, opts.id, opts.map);
    if (!existing) throw new Error(opts.notFound(opts.id));
    return existing;
  }

  if (opts.touchUpdatedAt !== false) {
    clause.fields.push(`updated_at = NOW()`);
  }

  const { rows } = await opts.pool.query<Row>(
    `UPDATE ${opts.table} SET ${clause.fields.join(", ")} WHERE id = $${clause.nextIndex} RETURNING *`,
    [...clause.values, opts.id],
  );
  if (!rows[0]) throw new Error(opts.notFound(opts.id));
  return opts.map(rows[0]);
}

/**
 * SQL fragment ranking task.priority numerically (critical=4, high=3,
 * medium=2, low=1, unknown/NULL=0). TEXT alphabetical DESC orders
 * 'low' > 'high' > 'critical' (backwards), so ORDER BY clauses on
 * priority need this numeric expression instead.
 *
 * Pass `t.priority` when joined with a task alias (session-repo claim),
 * or a bare `priority` for a query rooted on `task` itself.
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
