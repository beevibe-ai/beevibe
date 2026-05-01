import { apiBaseUrl, userKey } from "./config";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
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
  const init: RequestInit = {
    ...rest,
    signal,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(userKey ? { Authorization: `Bearer ${userKey}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  const res = await fetch(buildUrl(path, query), init);
  const text = await res.text();
  const parsed: unknown = text ? safeParse(text) : undefined;

  if (!res.ok) {
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
