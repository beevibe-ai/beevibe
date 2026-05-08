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
 * Room-scoped fan-out is intentionally absent here: rooms come back in
 * Phase 9 of the daemon-first restructure plan; this module re-grows
 * the room.message and session.room_id branches at that point.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { BvEvent } from "./manager.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX_ENTRIES = 5_000;

interface CacheEntry {
  owners: ReadonlySet<string>;
  expires_at: number;
}

export interface OwnerLookupConfig {
  /** Override default TTL. Reads `BEEVIBE_OWNER_CACHE_TTL_MS` if unset. */
  cacheTtlMs?: number;
  /** Override default cap. Reads `BEEVIBE_OWNER_CACHE_MAX_ENTRIES` if unset. */
  cacheMaxEntries?: number;
}

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
   * event type isn't owner-scoped, or the lookup query failed — in any
   * of those cases the manager drops the event rather than fan out.
   */
  async ownersOf(event: BvEvent): Promise<ReadonlySet<string>> {
    const cacheKey = `${event.event}|${event.id}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires_at > now) return cached.owners;

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
    this.cache.set(cacheKey, { owners, expires_at: now + this.cacheTtlMs });
    return owners;
  }

  private async lookup(event: BvEvent): Promise<ReadonlySet<string>> {
    if (event.event.startsWith("task.")) {
      const { rows } = await this.pool.query<{ owner: string | null }>(
        `SELECT a.owner_id AS owner
         FROM task t
         LEFT JOIN agent a ON a.id = t.assignee_id
         WHERE t.id = $1`,
        [event.id],
      );
      return rows[0]?.owner ? new Set([rows[0].owner]) : new Set();
    }

    if (event.event.startsWith("agent.")) {
      const { rows } = await this.pool.query<{ owner: string | null }>(
        `SELECT owner_id AS owner FROM agent WHERE id = $1`,
        [event.id],
      );
      return rows[0]?.owner ? new Set([rows[0].owner]) : new Set();
    }

    if (event.event.startsWith("session.")) {
      // Single-tenant: just the agent's owner. Room fan-out re-grows
      // here in Phase 9 when rooms come back.
      const { rows } = await this.pool.query<{ owner: string | null }>(
        `SELECT a.owner_id AS owner
         FROM session s
         JOIN agent a ON a.id = s.agent_id
         WHERE s.id = $1`,
        [event.id],
      );
      return rows[0]?.owner ? new Set([rows[0].owner]) : new Set();
    }

    if (event.event.startsWith("memory.fact.")) {
      const { rows } = await this.pool.query<{ owner: string | null }>(
        `SELECT a.owner_id AS owner
         FROM memory_fact f
         JOIN agent a ON a.id = f.agent_id
         WHERE f.id = $1`,
        [event.id],
      );
      return rows[0]?.owner ? new Set([rows[0].owner]) : new Set();
    }

    if (event.event === "promotion.created") {
      const { rows } = await this.pool.query<{ owner: string | null }>(
        `SELECT a.owner_id AS owner
         FROM memory_promotion_event mpe
         JOIN agent a ON a.id = mpe.origin_agent_id
         WHERE mpe.id = $1`,
        [event.id],
      );
      return rows[0]?.owner ? new Set([rows[0].owner]) : new Set();
    }

    if (event.event === "mesh.activity") {
      const { rows } = await this.pool.query<{
        initiator: string | null;
        counterparty: string | null;
      }>(
        `SELECT
           ai.owner_id AS initiator,
           ac.owner_id AS counterparty
         FROM negotiation n
         LEFT JOIN agent ai ON ai.id = n.initiator_agent_id
         LEFT JOIN agent ac ON ac.id = n.counterparty_agent_id
         WHERE n.id = $1`,
        [event.id],
      );
      const set = new Set<string>();
      if (rows[0]?.initiator) set.add(rows[0].initiator);
      if (rows[0]?.counterparty) set.add(rows[0].counterparty);
      return set;
    }

    if (event.event === "runtime.updated") {
      const { rows } = await this.pool.query<{ owner: string | null }>(
        `SELECT d.owner_person_id AS owner
         FROM runtime r
         JOIN daemon d ON d.id = r.daemon_id
         WHERE r.id = $1`,
        [event.id],
      );
      return rows[0]?.owner ? new Set([rows[0].owner]) : new Set();
    }

    return new Set();
  }

  /** @internal Tests only. */
  clearCache(): void {
    this.cache.clear();
  }
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
