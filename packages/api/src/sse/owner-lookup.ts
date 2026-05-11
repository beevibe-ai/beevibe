/**
 * Per-event owner lookup for SSE filtering.
 *
 * The pg_notify triggers don't carry owner info — payload is just
 * `{event, id}`. To deliver an event only to its owning user(s), the
 * listener resolves the entity row by id and walks to its agent's
 * `owner_id`. Most events have a single owner; mesh activity has two
 * (initiator + counterparty).
 *
 * Lookups are cached for `BEEVIBE_OWNER_CACHE_TTL_MS` (default 30s).
 * `owner_id` is treated as immutable for the lifetime of an entity —
 * if a future feature reassigns agents across owners, that change is
 * masked from SSE for up to TTL_MS. Tests cover this assumption.
 *
 * Single-owner only here. Multi-owner room fan-out belongs in a
 * separate handler when rooms ship.
 */

import { readPositiveInt } from "@beevibe/core";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { BvEvent } from "./manager.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX_ENTRIES = 5_000;
/** Cap any single owner-resolution query at 2s — beyond that the SSE
 *  pipeline back-pressures and we'd rather drop than block. */
const QUERY_TIMEOUT_MS = 2_000;

interface CacheEntry {
  owners: ReadonlySet<string>;
  expiresAt: number;
}

export interface OwnerLookupConfig {
  /** Override default TTL. Reads `BEEVIBE_OWNER_CACHE_TTL_MS` if unset. */
  cacheTtlMs?: number;
  /** Override default cap. Reads `BEEVIBE_OWNER_CACHE_MAX_ENTRIES` if unset. */
  cacheMaxEntries?: number;
}

/**
 * One row per resolution shape. Most events resolve to exactly one
 * owner via a single-row JOIN; mesh.activity is the lone two-owner
 * shape. Lookup matches by prefix (with optional dot) or by exact name.
 */
interface ResolverRule {
  match: (eventName: string) => boolean;
  resolve: (lookup: OwnerLookup, id: string) => Promise<ReadonlySet<string>>;
}

const SINGLE_OWNER_SQL = {
  task: `SELECT a.owner_id AS owner
         FROM task t LEFT JOIN agent a ON a.id = t.assignee_id
         WHERE t.id = $1`,
  agent: `SELECT owner_id AS owner FROM agent WHERE id = $1`,
  session: `SELECT a.owner_id AS owner
            FROM session s JOIN agent a ON a.id = s.agent_id
            WHERE s.id = $1`,
  memoryFact: `SELECT a.owner_id AS owner
               FROM memory_fact f JOIN agent a ON a.id = f.agent_id
               WHERE f.id = $1`,
  promotion: `SELECT a.owner_id AS owner
              FROM memory_promotion_event mpe JOIN agent a ON a.id = mpe.origin_agent_id
              WHERE mpe.id = $1`,
  runtime: `SELECT d.owner_person_id AS owner
            FROM runtime r JOIN daemon d ON d.id = r.daemon_id
            WHERE r.id = $1`,
} as const;

const MESH_ACTIVITY_SQL = `SELECT
    ai.owner_id AS initiator,
    ac.owner_id AS counterparty
  FROM negotiation n
  LEFT JOIN agent ai ON ai.id = n.initiator_agent_id
  LEFT JOIN agent ac ON ac.id = n.counterparty_agent_id
  WHERE n.id = $1`;

const RESOLVERS: ResolverRule[] = [
  { match: (e) => e.startsWith("task."),        resolve: (l, id) => l.singleOwnerSet(SINGLE_OWNER_SQL.task, id) },
  { match: (e) => e.startsWith("agent."),       resolve: (l, id) => l.singleOwnerSet(SINGLE_OWNER_SQL.agent, id) },
  { match: (e) => e.startsWith("session."),     resolve: (l, id) => l.singleOwnerSet(SINGLE_OWNER_SQL.session, id) },
  { match: (e) => e.startsWith("memory.fact."), resolve: (l, id) => l.singleOwnerSet(SINGLE_OWNER_SQL.memoryFact, id) },
  { match: (e) => e === "promotion.created",    resolve: (l, id) => l.singleOwnerSet(SINGLE_OWNER_SQL.promotion, id) },
  { match: (e) => e === "runtime.updated",      resolve: (l, id) => l.singleOwnerSet(SINGLE_OWNER_SQL.runtime, id) },
  { match: (e) => e === "mesh.activity",        resolve: (l, id) => l.meshOwners(id) },
];

export class OwnerLookup {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<ReadonlySet<string>>>();
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;

  constructor(
    private readonly pool: Pool,
    config: OwnerLookupConfig = {},
  ) {
    this.cacheTtlMs =
      config.cacheTtlMs ??
      readPositiveInt(process.env.BEEVIBE_OWNER_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
    this.cacheMaxEntries =
      config.cacheMaxEntries ??
      readPositiveInt(
        process.env.BEEVIBE_OWNER_CACHE_MAX_ENTRIES,
        DEFAULT_CACHE_MAX_ENTRIES,
      );
  }

  /**
   * Returns the set of person ids that should receive `event`. Empty set
   * means the entity is gone (deleted between trigger and lookup), the
   * event type isn't owner-scoped, or the lookup query failed/timed
   * out — in any of those cases the manager drops the event rather
   * than fan out.
   */
  async ownersOf(event: BvEvent): Promise<ReadonlySet<string>> {
    const cacheKey = `${event.event}|${event.id}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.owners;

    // N+1 guard: if a concurrent caller is already resolving this same
    // key, share its in-flight promise rather than firing a duplicate
    // query.
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = this.fetchAndCache(cacheKey, event, now);
    this.inFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async fetchAndCache(
    cacheKey: string,
    event: BvEvent,
    now: number,
  ): Promise<ReadonlySet<string>> {
    let owners: ReadonlySet<string>;
    try {
      owners = await this.lookup(event);
    } catch (err) {
      // Drop the event rather than crash the SSE pipeline. Pool flakes
      // shouldn't fan out to disconnect every subscribed browser.
      console.warn(
        `[OwnerLookup] lookup failed for ${event.event}/${event.id}: ${(err as Error).message}`,
      );
      return new Set();
    }
    if (this.cache.size >= this.cacheMaxEntries) {
      // FIFO eviction: drop the oldest entry. Map iteration is insertion
      // order so the first key is the oldest. LRU is a follow-up.
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    // Reinsert at tail so a stale-then-refreshed entry behaves as
    // "recently used" under FIFO eviction.
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, { owners, expiresAt: now + this.cacheTtlMs });
    return owners;
  }

  private async lookup(event: BvEvent): Promise<ReadonlySet<string>> {
    const rule = RESOLVERS.find((r) => r.match(event.event));
    return rule ? rule.resolve(this, event.id) : new Set();
  }

  /** @internal — used by the resolver table. */
  async singleOwnerSet(sql: string, id: string): Promise<ReadonlySet<string>> {
    const { rows } = await this.queryWithTimeout<{ owner: string | null }>(sql, [id]);
    return rows[0]?.owner ? new Set([rows[0].owner]) : new Set();
  }

  /** @internal — used by the resolver table. */
  async meshOwners(id: string): Promise<ReadonlySet<string>> {
    const { rows } = await this.queryWithTimeout<{
      initiator: string | null;
      counterparty: string | null;
    }>(MESH_ACTIVITY_SQL, [id]);
    const set = new Set<string>();
    if (rows[0]?.initiator) set.add(rows[0].initiator);
    if (rows[0]?.counterparty) set.add(rows[0].counterparty);
    return set;
  }

  private async queryWithTimeout<R extends Record<string, unknown>>(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: R[] }> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`owner-lookup timeout (${QUERY_TIMEOUT_MS}ms)`)), QUERY_TIMEOUT_MS);
    });
    return Promise.race([
      this.pool.query<R>(sql, params) as Promise<{ rows: R[] }>,
      timeout,
    ]);
  }

  /** @internal Tests only. */
  clearCache(): void {
    this.cache.clear();
  }
}

