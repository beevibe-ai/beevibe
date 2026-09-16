/**
 * `BeevibeApiServer` lifecycle + wiring tests.
 *
 * The class is the composition point every deployment goes through, but
 * nothing exercised it directly — the only coverage came from integration
 * suites that need a live Postgres, so a bare checkout ran none of it.
 * These tests are hermetic: a fake `LookupApiKeyDeps` (the middleware
 * short-circuits on a missing/malformed header before it ever reaches a
 * repo) and an ephemeral port for the listen-path assertions.
 *
 * Covered:
 *   - public `/health` needs no Authorization
 *   - middleware order: CORS ahead of `json()` + auth, so preflights get
 *     204 rather than 400/401
 *   - `getAuthMiddleware()` hands back a usable, unmounted handler
 *   - `json()` body parsing is mounted
 *   - start/stop idempotence and socket-timeout application
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { LookupApiKeyDeps } from "@beevibe/core/auth";
import { BeevibeApiServer, DEFAULT_SOCKET_TIMEOUT_MS } from "./server.js";

/**
 * The auth middleware rejects missing/malformed bearer headers before
 * touching either repo, so the tests here never need a real one. A repo
 * call would be a bug in the middleware, and `findByApiKey` throwing
 * surfaces it loudly rather than silently passing.
 */
const authDeps = {
  agentRepo: {
    findByApiKey: () => {
      throw new Error("unexpected agentRepo lookup");
    },
  },
  personRepo: {
    findByApiKey: () => {
      throw new Error("unexpected personRepo lookup");
    },
  },
} as unknown as LookupApiKeyDeps;

const started: BeevibeApiServer[] = [];

function makeServer(
  config: Partial<ConstructorParameters<typeof BeevibeApiServer>[0]> = {},
): BeevibeApiServer {
  // Port 0 → the OS picks a free one, so suites can run concurrently.
  const server = new BeevibeApiServer({ port: 0, authDeps, ...config });
  started.push(server);
  return server;
}

function boundPort(server: BeevibeApiServer): number {
  const address = server.getHttpServer().address() as AddressInfo | null;
  if (!address) throw new Error("server is not listening");
  return address.port;
}

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.stop();
  }
});

describe("BeevibeApiServer — routes", () => {
  it("serves GET /health publicly, with no Authorization header", async () => {
    const res = await request(makeServer().getApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: "0.0.1" });
  });

  it("parses JSON bodies for routes mounted on the app", async () => {
    const server = makeServer();
    server.getApp().post("/echo", (req, res) => {
      res.json({ received: req.body });
    });

    const res = await request(server.getApp()).post("/echo").send({ hello: "world" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { hello: "world" } });
  });

  it("returns 404 for unknown paths", async () => {
    const res = await request(makeServer().getApp()).get("/nope");

    expect(res.status).toBe(404);
  });
});

describe("BeevibeApiServer — CORS placement", () => {
  it("answers a preflight 204 with the echoed origin, before auth runs", async () => {
    const res = await request(makeServer().getApp())
      .options("/health")
      .set("Origin", "http://localhost:3001");

    // 204 (not 401) is the proof that CORS is mounted ahead of auth:
    // a preflight carries no Authorization header by spec.
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toBe("Origin");
  });

  it("still answers 204 for a disallowed origin, but without the allow header", async () => {
    const res = await request(makeServer().getApp())
      .options("/health")
      .set("Origin", "https://evil.example.com");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("honours extra origins passed via corsAllowedOrigins", async () => {
    const server = makeServer({
      corsAllowedOrigins: ["https://app.beevibe.ai"],
    });

    const allowed = await request(server.getApp())
      .get("/health")
      .set("Origin", "https://app.beevibe.ai");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.beevibe.ai");

    const other = await request(server.getApp())
      .get("/health")
      .set("Origin", "https://app.other.ai");
    expect(other.status).toBe(200);
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("BeevibeApiServer — auth middleware", () => {
  it("hands back a handler that 401s a request with no Authorization", async () => {
    const server = makeServer();
    server.getApp().get("/protected", server.getAuthMiddleware(), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(server.getApp()).get("/protected");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_authorization");
  });

  it("is not mounted globally — /health stays reachable", async () => {
    const server = makeServer();
    server.getApp().get("/protected", server.getAuthMiddleware(), (_req, res) => {
      res.json({ ok: true });
    });

    expect((await request(server.getApp()).get("/health")).status).toBe(200);
    expect((await request(server.getApp()).get("/protected")).status).toBe(401);
  });
});

describe("BeevibeApiServer — lifecycle", () => {
  it("listens after start() and serves over the real socket", async () => {
    const server = makeServer();
    await server.start();

    const res = await request(`http://127.0.0.1:${boundPort(server)}`).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("start() twice is a no-op — the second call keeps the same port", async () => {
    const server = makeServer();
    await server.start();
    const first = boundPort(server);

    // A second listen() on an already-bound server would throw
    // ERR_SERVER_ALREADY_LISTEN; the `listening` guard short-circuits.
    await expect(server.start()).resolves.toBeUndefined();
    expect(boundPort(server)).toBe(first);
  });

  it("stop() before start() resolves without touching the socket", async () => {
    await expect(makeServer().stop()).resolves.toBeUndefined();
  });

  it("stop() closes the listener, and a second stop() is a no-op", async () => {
    const server = makeServer();
    await server.start();

    await server.stop();
    expect(server.getHttpServer().address()).toBeNull();

    // close() on an already-closed server hands back ERR_SERVER_NOT_RUNNING;
    // the `listening` guard means we never get there.
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("applies the default socket timeout on start", async () => {
    const server = makeServer();
    await server.start();

    expect(server.getHttpServer().timeout).toBe(DEFAULT_SOCKET_TIMEOUT_MS);
    expect(DEFAULT_SOCKET_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it("applies a socketTimeoutMs override instead of the default", async () => {
    const server = makeServer({ socketTimeoutMs: 1234 });
    await server.start();

    expect(server.getHttpServer().timeout).toBe(1234);
  });

  it("wraps the same Express app the http.Server serves", async () => {
    const server = makeServer();
    // Phase 4: the daemon's WSS upgrade handler attaches to this exact
    // http.Server, so it has to be the one backing the app.
    expect(server.getHttpServer().listeners("request")).toContain(server.getApp());
  });
});
