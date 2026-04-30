import type { SessionRepository } from "@beevibe/core";

export interface SessionCacheConfig {
  sessionRepo: SessionRepository;
  /** Maximum entries before LRU eviction kicks in. Default 1000. */
  maxEntries?: number;
  /** Idle timeout in ms. After this much time without access, eviction fires. Default 30 min. */
  idleTimeoutMs?: number;
  /**
   * Called after a session is evicted (idle or LRU). Typically wired to
   * `memoryAgent.onTaskComplete(beevibeSid)` for fact promotion. Errors are
   * caught and logged.
   */
  onEvict?: (beevibeSid: string, reason: "idle" | "lru" | "explicit") => Promise<void>;
}

interface CacheEntry {
  beevibeSid: string;
  lastAccess: number;
}

/**
 * In-memory cache mapping MCP-protocol session ids (assigned on `initialize`,
 * echoed by client per spec) to beevibe session row ids. Used by Path B
 * (user-driven `bv_u_` flows) to resolve the database session id from header
 * round-trips.
 *
 * Eviction:
 *   - LRU when `maxEntries` reached on `set()`.
 *   - Idle timeout via the periodic sweep (`startIdleSweep`).
 * Both eviction paths call `sessionRepo.update(sid, {status:'succeeded'})`
 * and fire `onEvict` to allow downstream cleanup (memory promotion).
 *
 * Lost on api-server restart — matches the resolver-map limitation. M6 doc'd.
 */
export class SessionCache {
  private map = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly idleTimeoutMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: SessionCacheConfig) {
    this.maxEntries = config.maxEntries ?? 1000;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30 * 60 * 1000;
  }

  set(mcpSid: string, beevibeSid: string): void {
    if (!this.map.has(mcpSid) && this.map.size >= this.maxEntries) {
      this.evictOldest("lru");
    }
    this.map.set(mcpSid, { beevibeSid, lastAccess: Date.now() });
  }

  get(mcpSid: string): string | undefined {
    const entry = this.map.get(mcpSid);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    return entry.beevibeSid;
  }

  /** Explicit removal (e.g., on `DELETE /mcp`). Fires onEvict with reason='explicit'. */
  async delete(mcpSid: string): Promise<boolean> {
    const entry = this.map.get(mcpSid);
    if (!entry) return false;
    this.map.delete(mcpSid);
    await this.runEviction(entry.beevibeSid, "explicit");
    return true;
  }

  size(): number {
    return this.map.size;
  }

  /** Begin periodic sweep. Idempotent — calling twice is a no-op. */
  startIdleSweep(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle();
    }, intervalMs);
  }

  stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Public for test access — invoke a sweep on demand. */
  async sweepIdle(): Promise<void> {
    const now = Date.now();
    const evictees: Array<[string, string]> = [];
    for (const [mcpSid, entry] of this.map.entries()) {
      if (now - entry.lastAccess > this.idleTimeoutMs) {
        evictees.push([mcpSid, entry.beevibeSid]);
      }
    }
    for (const [mcpSid, beevibeSid] of evictees) {
      this.map.delete(mcpSid);
      await this.runEviction(beevibeSid, "idle");
    }
  }

  private evictOldest(reason: "lru"): void {
    let oldestKey: string | undefined;
    let oldestAccess = Infinity;
    for (const [k, v] of this.map.entries()) {
      if (v.lastAccess < oldestAccess) {
        oldestAccess = v.lastAccess;
        oldestKey = k;
      }
    }
    if (!oldestKey) return;
    const entry = this.map.get(oldestKey);
    this.map.delete(oldestKey);
    if (entry) {
      void this.runEviction(entry.beevibeSid, reason);
    }
  }

  private async runEviction(
    beevibeSid: string,
    reason: "idle" | "lru" | "explicit",
  ): Promise<void> {
    try {
      await this.config.sessionRepo.update(beevibeSid, {
        status: "succeeded",
        completed_at: new Date(),
      });
      if (this.config.onEvict) {
        await this.config.onEvict(beevibeSid, reason);
      }
    } catch (err) {
      console.error(
        `[session-cache] eviction (${reason}) failed for ${beevibeSid}:`,
        err,
      );
    }
  }
}
