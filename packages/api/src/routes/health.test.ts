/**
 * `GET /health` is the unauthenticated readiness probe Railway and
 * friends poll. Two things must not regress: it answers without any
 * auth middleware in front of it, and the body stays the `{ ok: true }`
 * shape the probes match on.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { healthRoute } from "./health.js";

function app() {
  const a = express();
  a.get("/health", healthRoute);
  return a;
}

describe("GET /health", () => {
  it("answers 200 with ok and a version, no auth required", async () => {
    const res = await request(app()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: "0.0.1" });
  });

  it("is JSON so a probe can parse it", async () => {
    const res = await request(app()).get("/health");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
