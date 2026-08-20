import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { healthRoute } from "./health.js";

/**
 * `/health` is a public liveness probe and the deploy target's readiness
 * check — the shape and status stability matter more than the contents.
 */
describe("healthRoute", () => {
  function makeApp() {
    const app = express();
    app.get("/health", healthRoute);
    return app;
  }

  it("responds 200 with { ok: true, version } as JSON", async () => {
    const res = await request(makeApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ ok: true, version: "0.0.1" });
  });

  it("stays unauthenticated — no Authorization header required", async () => {
    // The route function itself takes no middleware; if a change ever
    // introduces one, this call will 401 or 500 and this test fails.
    const res = await request(makeApp()).get("/health");
    expect(res.status).toBe(200);
  });
});
