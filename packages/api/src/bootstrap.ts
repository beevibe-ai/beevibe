import {
  PostgresAgentRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  createPool,
} from "@beevibe/core/adapters/postgres";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { BeevibeApiServer } from "./server.js";
import { SessionCache } from "./session-cache.js";

export interface BootstrapConfig {
  databaseUrl: string;
  /** Default 3000. */
  port?: number;
  /** Default 5 minutes. */
  socketTimeoutMs?: number;
  /** Default 1000. */
  sessionCacheMaxEntries?: number;
  /** Default 30 minutes. */
  sessionCacheIdleTimeoutMs?: number;
}

export interface BootstrapResult {
  server: BeevibeApiServer;
  sessionCache: SessionCache;
  pool: Pool;
  shutdown: () => Promise<void>;
}

/**
 * Composition root for the api server. M6.1 wires the skeleton:
 *   - pool + 3 repos (agent, person, session)
 *   - session cache with periodic idle sweep
 *   - api server with public /health + bearer auth middleware
 *
 * M6.2+ extends this with memory services, MCP routes, mesh server, etc.
 * Same shape as `@beevibe/executor`'s bootstrap so wiring is symmetric across
 * the two binary composition roots.
 */
export async function bootstrap(cfg: BootstrapConfig): Promise<BootstrapResult> {
  const pool = createPool({ connectionString: cfg.databaseUrl });

  const agentRepo = new PostgresAgentRepository(pool);
  const personRepo = new PostgresPersonRepository(pool);
  const sessionRepo = new PostgresSessionRepository(pool);

  const sessionCache = new SessionCache({
    sessionRepo,
    maxEntries: cfg.sessionCacheMaxEntries,
    idleTimeoutMs: cfg.sessionCacheIdleTimeoutMs,
    // onEvict will be wired to memoryAgent.onTaskComplete in M6.2 once the
    // memory services land in this composition root.
  });
  sessionCache.startIdleSweep();

  const server = new BeevibeApiServer({
    port: cfg.port ?? 3000,
    socketTimeoutMs: cfg.socketTimeoutMs,
    authDeps: { agentRepo, personRepo },
  });

  const shutdown = async (): Promise<void> => {
    sessionCache.stopIdleSweep();
    await server.stop();
    await pool.end();
  };

  return { server, sessionCache, pool, shutdown };
}
