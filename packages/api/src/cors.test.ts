/**
 * CORS middleware unit tests. Drive the middleware with a fake req/res
 * pair so the tests don't need a live server. Covers:
 *   - localhost defaults (any port, http or https)
 *   - explicit allowlist via config
 *   - same-origin requests (no Origin header) pass through
 *   - OPTIONS preflight: 204 with CORS headers when allowed; 204
 *     without when disallowed
 *   - non-OPTIONS disallowed: passes through with no CORS headers (the
 *     browser will block the response itself)
 *   - parseAllowedOrigins env splitting
 */

import { describe, expect, it, vi } from "vitest";
import {
  createCorsMiddleware,
  isAllowedOrigin,
  parseAllowedOrigins,
} from "./cors.js";

interface FakeReq {
  method: string;
  headers: Record<string, string | undefined>;
}

interface FakeRes {
  statusCode?: number;
  ended: boolean;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  setHeader(name: string, value: string): void;
  end(): void;
}

function makeReq(method: string, origin?: string): FakeReq {
  return { method, headers: origin ? { origin } : {} };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: undefined,
    ended: false,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end() {
      this.ended = true;
    },
  };
  return res;
}

function run(
  middleware: ReturnType<typeof createCorsMiddleware>,
  req: FakeReq,
): { res: FakeRes; nextCalled: boolean } {
  const res = makeRes();
  const next = vi.fn();
  // express types: middleware ignores extra args at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middleware(req as any, res as any, next);
  return { res, nextCalled: next.mock.calls.length > 0 };
}

describe("isAllowedOrigin", () => {
  it("accepts localhost on any port (http + https)", () => {
    expect(isAllowedOrigin("http://localhost:3000", [])).toBe(true);
    expect(isAllowedOrigin("http://localhost:3002", [])).toBe(true);
    expect(isAllowedOrigin("http://localhost", [])).toBe(true);
    expect(isAllowedOrigin("https://localhost:8443", [])).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3000", [])).toBe(true);
    expect(isAllowedOrigin("https://127.0.0.1:8443", [])).toBe(true);
  });

  it("rejects origins that look like localhost but aren't (subdomain trick)", () => {
    expect(isAllowedOrigin("http://localhost.evil.com", [])).toBe(false);
    expect(isAllowedOrigin("http://evil.com/localhost", [])).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1.evil.com", [])).toBe(false);
  });

  it("accepts exact origins from the configured allowlist", () => {
    const list = ["https://app.beevibe.ai", "https://staging.beevibe.ai"];
    expect(isAllowedOrigin("https://app.beevibe.ai", list)).toBe(true);
    expect(isAllowedOrigin("https://staging.beevibe.ai", list)).toBe(true);
  });

  it("rejects near-matches (different host, scheme, or port)", () => {
    const list = ["https://app.beevibe.ai"];
    expect(isAllowedOrigin("http://app.beevibe.ai", list)).toBe(false);
    expect(isAllowedOrigin("https://app.beevibe.ai:8443", list)).toBe(false);
    expect(isAllowedOrigin("https://other.beevibe.ai", list)).toBe(false);
    expect(isAllowedOrigin("https://app.beevibe.ai/", list)).toBe(false);
  });
});

describe("parseAllowedOrigins", () => {
  it("returns empty for undefined / empty", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
  });

  it("splits on commas + trims whitespace", () => {
    expect(parseAllowedOrigins("https://a.com, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("drops empty entries from trailing commas / double commas", () => {
    expect(parseAllowedOrigins("https://a.com,,https://b.com,")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
});

describe("createCorsMiddleware", () => {
  it("sets CORS headers for an allowed origin (GET request)", () => {
    const middleware = createCorsMiddleware();
    const { res, nextCalled } = run(
      middleware,
      makeReq("GET", "http://localhost:3002"),
    );
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:3002",
    );
    expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(res.headers["Vary"]).toBe("Origin");
    expect(nextCalled).toBe(true);
  });

  it("does NOT set CORS headers for a disallowed origin (browser blocks)", () => {
    const middleware = createCorsMiddleware();
    const { res, nextCalled } = run(
      middleware,
      makeReq("GET", "https://evil.com"),
    );
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(res.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it("answers preflight OPTIONS with 204 + CORS headers when origin allowed", () => {
    const middleware = createCorsMiddleware();
    const { res, nextCalled } = run(
      middleware,
      makeReq("OPTIONS", "http://localhost:3002"),
    );
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:3002",
    );
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(res.headers["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(res.headers["Access-Control-Max-Age"]).toBe("86400");
    // Don't pass to downstream — preflights short-circuit.
    expect(nextCalled).toBe(false);
  });

  it("answers preflight OPTIONS with 204 + NO CORS headers when origin disallowed", () => {
    const middleware = createCorsMiddleware();
    const { res, nextCalled } = run(
      middleware,
      makeReq("OPTIONS", "https://evil.com"),
    );
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(nextCalled).toBe(false);
  });

  it("passes same-origin requests through (no Origin header)", () => {
    const middleware = createCorsMiddleware();
    const { res, nextCalled } = run(middleware, makeReq("GET"));
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(nextCalled).toBe(true);
    expect(res.ended).toBe(false);
  });

  it("answers OPTIONS without an Origin with 204 + no CORS headers", () => {
    const middleware = createCorsMiddleware();
    const { res, nextCalled } = run(middleware, makeReq("OPTIONS"));
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(nextCalled).toBe(false);
  });

  it("honors a configured production origin", () => {
    const middleware = createCorsMiddleware({
      allowedOrigins: ["https://app.beevibe.ai"],
    });
    const allowed = run(middleware, makeReq("GET", "https://app.beevibe.ai"));
    expect(allowed.res.headers["Access-Control-Allow-Origin"]).toBe(
      "https://app.beevibe.ai",
    );

    const blocked = run(middleware, makeReq("GET", "https://other.beevibe.ai"));
    expect(blocked.res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("respects custom allowedHeaders / allowedMethods / maxAge config", () => {
    const middleware = createCorsMiddleware({
      allowedHeaders: ["X-Custom", "Authorization"],
      allowedMethods: ["GET", "POST"],
      maxAgeSeconds: 60,
    });
    const { res } = run(
      middleware,
      makeReq("OPTIONS", "http://localhost:3002"),
    );
    expect(res.headers["Access-Control-Allow-Headers"]).toBe("X-Custom, Authorization");
    expect(res.headers["Access-Control-Allow-Methods"]).toBe("GET, POST");
    expect(res.headers["Access-Control-Max-Age"]).toBe("60");
  });
});
