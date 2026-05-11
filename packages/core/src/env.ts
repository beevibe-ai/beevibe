/**
 * Composition-root environment helpers shared by the api + scheduler
 * binaries. Pure functions over a snapshot of `process.env` (not the
 * live object) so call sites stay easy to test.
 */

export interface EnvSnapshot {
  readonly BEEVIBE_MCP_SERVER_URL?: string;
  readonly RAILWAY_PUBLIC_DOMAIN?: string;
  readonly [key: string]: string | undefined;
}

/**
 * Resolve the URL agent CLIs should hit for MCP tool calls. Operators
 * normally set `BEEVIBE_MCP_SERVER_URL` explicitly; on Railway-style
 * PaaS we fall back to `https://${RAILWAY_PUBLIC_DOMAIN}/mcp` so a
 * one-click deploy works without manual config.
 */
export function resolveMcpServerUrl(env: EnvSnapshot): string | undefined {
  if (env.BEEVIBE_MCP_SERVER_URL) return env.BEEVIBE_MCP_SERVER_URL;
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}/mcp`;
  return undefined;
}

/**
 * Parse an env var as a positive integer, falling back when missing,
 * empty, or non-numeric. Guards against `Number("")` returning 0 — which
 * silently binds an HTTP server to a random port.
 */
export function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
