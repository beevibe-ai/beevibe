/**
 * BeevibeApiServer — the composition the whole api sits behind: CORS
 * ahead of body parsing and auth, the public `/health` probe, and the
 * `http.Server` the daemon's WS upgrade handler attaches to.
 *
 * Fake auth deps only: the middleware itself is tested in
 * auth/middleware.test.ts. What's pinned here is the wiring — ordering,
 * what `start()`/`stop()` do to the listener, and the socket timeout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Server } from "node:http";
import request from "supertest";
import type { AgentRepository, PersonRepository } from "@beevibe/core";
import type { LookupApiKeyDeps } from "@beevibe/core/auth";
import { BeevibeApiServer, DEFAULT_SOCKET_TIMEOUT_MS } from "./server.js";

function fakeAuthDeps(): LookupApiKeyDeps {
  return {
    agentRepo: { findByApiKey: vi.fn(async () => undefined) } as unknown as AgentRepository,
    personRepo: { findByApiKey: vi.fn(async () => undefined) } as unknown as PersonRepository,
  };
}

/** Port 0 → the OS picks a free one, so tests never collide. */
function makeServer(
  overrides: Partial<ConstructorParameters<typeof BeevibeApiServer>[0]> = {},
): BeevibeApiServer {
  return new BeevibeApiServer({ port: 0, authDeps: fakeAuthDeps(), ...overrides });
}

const started: BeevibeApiServer[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.stop()));
});

describe("BeevibeApiServer — public surface", () => {
  it("answers /health without auth", async () => {
    const res = await request(makeServer().getApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: "0.0.1" });
  });

  it("parses JSON bodies for routes mounted later", async () => {
    const server = makeServer();
    server.getApp().post("/echo", (req, res) => {
      res.json({ got: req.body });
    });

    const res = await request(server.getApp()).post("/echo").send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ got: { a: 1 } });
  });

  it("exposes the auth middleware for protected routes to mount", async () => {
    const server = makeServer();
    server.getApp().get("/private", server.getAuthMiddleware(), (_req, res) => {
      res.json({ reached: true });
    });

    const res = await request(server.getApp()).get("/private");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "missing_authorization" });
  });

  it("hands out the underlying http.Server for WS upgrade handlers", () => {
    expect(makeServer().getHttpServer()).toBeInstanceOf(Server);
  });
});

describe("BeevibeApiServer — CORS placement", () => {
  it("answers a localhost preflight 204 with credentialed echo headers", async () => {
    const res = await request(makeServer().getApp())
      .options("/health")
      .set("Origin", "http://localhost:3001");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toBe("Origin");
  });

  it("allows the configured extra origins and nothing else", async () => {
    const app = makeServer({ corsAllowedOrigins: ["https://app.beevibe.ai"] }).getApp();

    const allowed = await request(app).get("/health").set("Origin", "https://app.beevibe.ai");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.beevibe.ai");

    const denied = await request(app).get("/health").set("Origin", "https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    // Denied origins still get the response — CORS is enforced browser-side.
    expect(denied.status).toBe(200);
  });

  it("runs before auth, so an unauthenticated preflight is never 401", async () => {
    const server = makeServer();
    server.getApp().post("/private", server.getAuthMiddleware(), (_req, res) => {
      res.json({ reached: true });
    });

    const res = await request(server.getApp())
      .options("/private")
      .set("Origin", "http://localhost:3001")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
  });

  it("runs before body parsing, so a malformed-body preflight is never 400", async () => {
    const res = await request(makeServer().getApp())
      .options("/health")
      .set("Origin", "http://localhost:3001")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(204);
  });
});

describe("BeevibeApiServer — listener lifecycle", () => {
  it("binds on start, applies the default socket timeout, and is idempotent", async () => {
    const server = makeServer();
    started.push(server);

    await server.start();
    const http = server.getHttpServer();
    expect(http.listening).toBe(true);
    expect(http.timeout).toBe(DEFAULT_SOCKET_TIMEOUT_MS);

    // Second start must not try to listen again (that would EADDRINUSE
    // or throw ERR_SERVER_ALREADY_LISTEN).
    await expect(server.start()).resolves.toBeUndefined();
    expect(http.listening).toBe(true);
  });

  it("honours a socket-timeout override", async () => {
    const server = makeServer({ socketTimeoutMs: 1234 });
    started.push(server);

    await server.start();
    expect(server.getHttpServer().timeout).toBe(1234);
  });

  it("stop() closes the listener and is a no-op before start", async () => {
    const server = makeServer();
    await expect(server.stop()).resolves.toBeUndefined();

    await server.start();
    await server.stop();
    expect(server.getHttpServer().listening).toBe(false);

    // Re-startable after a stop — nothing latched the `listening` flag.
    started.push(server);
    await server.start();
    expect(server.getHttpServer().listening).toBe(true);
  });
});
