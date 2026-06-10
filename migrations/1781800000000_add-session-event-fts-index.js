/**
 * session_search Layer-3 substrate, part 3 of 3: GIN index on
 * session_event.content_fts.
 *
 * Lockless index build via CREATE INDEX CONCURRENTLY. This is the
 * production-safe variant: writers (INSERT/UPDATE/DELETE) keep working
 * while the index builds in the background. The trade-off is that
 * CONCURRENTLY cannot run inside a transaction, so this migration must
 * call `pgm.noTransaction()` before any DDL.
 *
 * Why this is a .js file rather than .sql: node-pg-migrate wraps every
 * .sql migration in BEGIN/COMMIT. CONCURRENTLY is incompatible with that.
 * The JS migration format exposes `pgm.noTransaction()` which sets the
 * runner's per-migration transaction flag to false.
 *
 * The index is PARTIAL (WHERE kind = 'agent') so size scales only with
 * agent-turn count, not total event count. content_fts is generated as
 * NULL for non-agent rows (see migration 1781700), so this WHERE matches
 * the only rows where content_fts is non-null anyway.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_event_agent_fts
      ON session_event USING GIN (content_fts)
      WHERE kind = 'agent'
  `);
};

exports.down = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_session_event_agent_fts`);
};
