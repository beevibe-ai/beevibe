/**
 * Runtime auth config. The api base URL is build-time (every visitor
 * hits the same backend). The user key is per-visitor — read from
 * localStorage on the client, never baked into the JS bundle. Each user
 * signs in via /sign-in (email + password OR pastes their `bv_u_` key);
 * the key persists in their browser only and is sent on every api
 * request as a Bearer token.
 *
 * Historical: `NEXT_PUBLIC_BV_USER_KEY` was honored as a dev fallback
 * pre-password-auth. Removed because it auto-signed-in every visitor
 * (and re-signed-in immediately after sign-out, since clearing
 * localStorage just dropped to the env fallback). With password auth
 * shipped, every visitor signs in with their own credentials.
 */

const rawBaseUrl = process.env.NEXT_PUBLIC_BV_API_URL?.trim();

export const apiBaseUrl: string | null =
  rawBaseUrl && rawBaseUrl.length > 0 ? rawBaseUrl.replace(/\/+$/, "") : null;

const STORAGE_KEY = "bv:user_key";

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
 * Returns the active user key, or null when no one's signed in.
 * SSR-safe: returns null during pre-render (SSR has no localStorage
 * and no per-visitor identity).
 */
export function getUserKey(): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored && stored.length > 0 ? stored : null;
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
