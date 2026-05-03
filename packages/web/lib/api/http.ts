import { apiBaseUrl, getUserKey } from "./config";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Server-supplied error code (e.g. "person_not_found"), when the body looks like {error}. */
  readonly errorCode?: string;
  /** Server-supplied human message — preferred for UI surfacing over raw HTTP status. */
  readonly serverMessage?: string;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    if (body && typeof body === "object") {
      const b = body as { error?: unknown; message?: unknown };
      if (typeof b.error === "string") this.errorCode = b.error;
      if (typeof b.message === "string") this.serverMessage = b.message;
    }
  }
}

/** Best-effort human-readable message: server message > error.message > raw status. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.serverMessage) return err.serverMessage;
    if (err.errorCode) return err.errorCode.replace(/_/g, " ");
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Routed when an api request returns 401 — the stored key is invalid /
 * revoked. The shell wires this to a redirect to /sign-in. Out-of-band
 * registration so http.ts stays decoupled from Next.js routing.
 */
let onUnauthorized: (() => void) | undefined;
export function setOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

export class ApiNotConfigured extends Error {
  constructor() {
    super("NEXT_PUBLIC_BV_API_URL is not set");
    this.name = "ApiNotConfigured";
  }
}

export interface FetchOptions extends Omit<RequestInit, "body"> {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
}

function buildUrl(path: string, query?: FetchOptions["query"]): string {
  if (!apiBaseUrl) throw new ApiNotConfigured();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${apiBaseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function fetchJson<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const { query, body, headers, signal, ...rest } = opts;
  const key = getUserKey();
  const init: RequestInit = {
    ...rest,
    signal,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  const res = await fetch(buildUrl(path, query), init);
  const text = await res.text();
  const parsed: unknown = text ? safeParse(text) : undefined;

  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(`HTTP ${res.status} ${res.statusText}`, res.status, parsed);
  }
  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
