/**
 * Per-event owner lookup for SSE filtering.
 *
 * The pg_notify triggers don't carry owner info — payload is just
 * `{event, id}`. To deliver an event only to its owning user(s), the
 * listener resolves the entity row by id and walks to its agent's
 * `owner_id`. Most events have a single owner; mesh activity has two
 * (initiator + target).
 *
 * Lookups are cached for 30s — owner_id is immutable for the lifetime
 * of an entity, but the cache cap keeps memory bounded under churn.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { BvEvent } from "./manager.js";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 5_000;

interface CacheEntry {
  owners: ReadonlySet<string>;
  expires_at: number;
}

export class OwnerLookup {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly pool: Pool) {}

  /**
   * Returns the set of person ids that should receive `event`. Empty set
   * means the entity is gone (deleted between trigger and lookup) or the
   * event type isn't owner-scoped — in which case we drop the event
   * rather than fan out.
   */
  async ownersOf(event: BvEvent): Promise<ReadonlySet<string>> {
    const cacheKey = `${event.event}|${event.id}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires_at > now) return cached.owners;

    const owners = await this.lookup(event);
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Crude eviction: drop the oldest entry. Map iteration is insertion
      // order so the first key is the oldest.
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, { owners, expires_at: now + CACHE_TTL_MS });
    return owners;
  }

  private async lookup(event: BvEvent): Promise<ReadonlySet<string>> {
    if (event.event.startsWith("task.")) {
      // Task → assignee_agent.owner_id (or creator_id if creator_type='person').
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
      // Session.step + session.updated both key off session.id.
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
      // Negotiation involves two parties — both their owners should see it.
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

    return new Set();
  }

  /** @internal Tests only. */
  clearCache(): void {
    this.cache.clear();
  }
}
