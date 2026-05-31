import type { NextRequest } from 'next/server';

export interface RateResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetSec: number;
}

const MAX = Number(process.env.RATE_LIMIT_MAX ?? 30);
const WINDOW = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 3600);

/** Best-effort in-memory fallback (per serverless instance). */
const buckets = new Map<string, { count: number; resetAt: number }>();

/** Resolve the caller's IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

/**
 * Fixed-window rate limit keyed by id (usually IP). Uses Upstash Redis over its
 * REST API when UPSTASH_REDIS_REST_URL/TOKEN are set (durable across the
 * distributed serverless fleet); otherwise falls back to per-instance memory.
 */
export async function rateLimit(id: string): Promise<RateResult> {
  if (!Number.isFinite(MAX) || MAX <= 0) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, limit: MAX, resetSec: 0 };
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      return await upstashLimit(url, token, id);
    } catch {
      // Transient Redis issue — degrade to in-memory rather than failing open hard.
    }
  }
  return memoryLimit(id);
}

function memoryLimit(id: string): RateResult {
  const now = Date.now();
  const existing = buckets.get(id);
  if (!existing || now > existing.resetAt) {
    // Opportunistic prune so the map can't grow unbounded.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
    }
    buckets.set(id, { count: 1, resetAt: now + WINDOW * 1000 });
    return { allowed: true, remaining: MAX - 1, limit: MAX, resetSec: WINDOW };
  }
  existing.count += 1;
  const resetSec = Math.ceil((existing.resetAt - now) / 1000);
  return {
    allowed: existing.count <= MAX,
    remaining: Math.max(0, MAX - existing.count),
    limit: MAX,
    resetSec,
  };
}

async function upstashLimit(url: string, token: string, id: string): Promise<RateResult> {
  const windowId = Math.floor(Date.now() / (WINDOW * 1000));
  const key = `ratelimit:${id}:${windowId}`;
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, WINDOW],
    ]),
  });
  if (!res.ok) throw new Error('upstash request failed');
  const data = (await res.json()) as Array<{ result: number }>;
  const count = Number(data[0]?.result ?? 0);
  const resetSec = WINDOW - (Math.floor(Date.now() / 1000) % WINDOW);
  return {
    allowed: count <= MAX,
    remaining: Math.max(0, MAX - count),
    limit: MAX,
    resetSec,
  };
}
