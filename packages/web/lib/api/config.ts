/**
 * Runtime auth config. The api base URL is build-time (every visitor
 * hits the same backend). The user key is per-visitor — read from
 * localStorage on the client, never baked into the JS bundle. Each user
 * pastes their `bv_u_` on the /sign-in page; the key persists in their
 * browser only and is sent on every api request as a Bearer token.
 *
 * `NEXT_PUBLIC_BV_USER_KEY` env is honored as a dev convenience: when
 * set, it's the default key for unauthed visitors and skips the sign-in
 * gate. Set it to empty in production deploys so every visitor signs in
 * with their own key.
 */

const rawBaseUrl = process.env.NEXT_PUBLIC_BV_API_URL?.trim();

export const apiBaseUrl: string | null =
  rawBaseUrl && rawBaseUrl.length > 0 ? rawBaseUrl.replace(/\/+$/, "") : null;

const STORAGE_KEY = "bv:user_key";
const ENV_FALLBACK_KEY = process.env.NEXT_PUBLIC_BV_USER_KEY?.trim() || null;

/** Subscribe to key-change events so React components can re-render. */
type Listener = () => void;
const listeners = new Set<Listener>();
function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Returns the active user key. SSR-safe: returns env fallback (or null)
 * during pre-render; on the client, reads localStorage and falls back to
 * env if nothing's stored. Exported for the api client + SSE.
 */
export function getUserKey(): string | null {
  if (typeof window === "undefined") return ENV_FALLBACK_KEY;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && stored.length > 0) return stored;
  return ENV_FALLBACK_KEY;
}

export function setUserKey(key: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, key);
  notify();
}

export function clearUserKey(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  notify();
}

export function subscribeToUserKey(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const isApiConfigured: boolean = apiBaseUrl !== null;

/** Format check only — server-side `lookupApiKey` does the real validation. */
export function isWellFormedUserKey(key: string): boolean {
  return /^bv_u_[A-Za-z0-9]{16,}$/.test(key.trim());
}
