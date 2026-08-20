/**
 * Pure-unit tests for the middleware bits that don't require Postgres.
 * The DB-backed pipeline (Authorization → lookupApiKey → req.caller) lives
 * in middleware.test.ts and only runs when DATABASE_URL_TEST is set.
 *
 * Here we cover:
 *   - createAuthMiddleware's synchronous 401 branches (missing header,
 *     malformed header) — no DB round-trip needed since `lookupApiKey` is
 *     never reached.
 *   - streamTokenAdapter's query→header shim, including precedence rules.
 *   - requireHuman / requireDaemon type-guard behavior on shaped req.caller
 *     values (agent, missing).
 */
import type { Request, Response } from "express";
import type { LookupApiKeyDeps } from "@beevibe/core/auth";
import { describe, expect, it, vi } from "vitest";
import {
  createAuthMiddleware,
  requireDaemon,
  requireHuman,
  streamTokenAdapter,
} from "./middleware.js";

function makeRes() {
  const res: Partial<Response> & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  } = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

// A deps bundle that would explode if reached — proves 401s short-circuit
// before any DB call.
const explosiveDeps: LookupApiKeyDeps = {
  agentRepo: new Proxy(
    {},
    { get: () => () => Promise.reject(new Error("agentRepo should not be reached")) },
  ) as unknown as LookupApiKeyDeps["agentRepo"],
  personRepo: new Proxy(
    {},
    { get: () => () => Promise.reject(new Error("personRepo should not be reached")) },
  ) as unknown as LookupApiKeyDeps["personRepo"],
  daemonRepo: new Proxy(
    {},
    { get: () => () => Promise.reject(new Error("daemonRepo should not be reached")) },
  ) as unknown as LookupApiKeyDeps["daemonRepo"],
};

describe("createAuthMiddleware — 401 short-circuits", () => {
  it("returns 401 missing_authorization when the header is absent", async () => {
    const mw = createAuthMiddleware(explosiveDeps);
    const req = { headers: {} } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "missing_authorization",
      message: "Authorization header required",
    });
  });

  it("returns 401 malformed_authorization when the header is not Bearer-shaped", async () => {
    const mw = createAuthMiddleware(explosiveDeps);
    const req = {
      headers: { authorization: "Basic abc123" },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "malformed_authorization",
      message: "Expected: Authorization: Bearer <token>",
    });
  });

  it("case-sensitive: 'bearer <token>' is treated as malformed", async () => {
    // The BEARER_PATTERN uses a capital B and no /i flag — pin that
    // decision so a silent relaxation trips the test.
    const mw = createAuthMiddleware(explosiveDeps);
    const req = {
      headers: { authorization: "bearer bv_a_something" },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "malformed_authorization",
      message: "Expected: Authorization: Bearer <token>",
    });
  });
});

describe("streamTokenAdapter", () => {
  it("copies ?token= into the Authorization header when absent", () => {
    const req = {
      headers: {} as Record<string, string | undefined>,
      query: { token: "bv_u_xyz" } as Record<string, unknown>,
    } as unknown as Request;
    const next = vi.fn();
    streamTokenAdapter(req, makeRes(), next);
    expect(req.headers.authorization).toBe("Bearer bv_u_xyz");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does NOT overwrite an existing Authorization header", () => {
    // Header takes precedence — the URL token is a fallback for browsers.
    const req = {
      headers: { authorization: "Bearer already_set" } as Record<
        string,
        string | undefined
      >,
      query: { token: "bv_u_from_url" } as Record<string, unknown>,
    } as unknown as Request;
    const next = vi.fn();
    streamTokenAdapter(req, makeRes(), next);
    expect(req.headers.authorization).toBe("Bearer already_set");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when neither ?token= nor Authorization is present", () => {
    const req = {
      headers: {} as Record<string, string | undefined>,
      query: {} as Record<string, unknown>,
    } as unknown as Request;
    const next = vi.fn();
    streamTokenAdapter(req, makeRes(), next);
    expect(req.headers.authorization).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("ignores a non-string ?token= query param (e.g. arrayified by qs)", () => {
    // Express query parser can produce string[] for `?token=a&token=b`;
    // the adapter only forwards a scalar string to keep the header shape
    // predictable.
    const req = {
      headers: {} as Record<string, string | undefined>,
      query: { token: ["a", "b"] } as unknown as Record<string, unknown>,
    } as unknown as Request;
    const next = vi.fn();
    streamTokenAdapter(req, makeRes(), next);
    expect(req.headers.authorization).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("always calls next() even on the pass-through path", () => {
    const next = vi.fn();
    streamTokenAdapter(
      { headers: {}, query: {} } as unknown as Request,
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("requireHuman / requireDaemon — shape gating", () => {
  it("requireHuman returns false + 403 for an agent caller", () => {
    const req = {
      caller: { source: "agent", agentId: "agt_1", hierarchyLevel: "team" },
    } as unknown as Request;
    const res = makeRes();
    expect(requireHuman(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "human_required",
      message: "this endpoint requires a bv_u_ token",
    });
  });

  it("requireHuman returns false + 403 when caller is missing entirely", () => {
    const req = {} as unknown as Request;
    const res = makeRes();
    expect(requireHuman(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("requireHuman returns true for a human caller (no response mutations)", () => {
    const req = {
      caller: {
        source: "human",
        agentId: "agt_1",
        hierarchyLevel: "team",
        personId: "prs_1",
      },
    } as unknown as Request;
    const res = makeRes();
    expect(requireHuman(req, res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("requireDaemon returns false + 403 for a human caller", () => {
    const req = {
      caller: {
        source: "human",
        agentId: "agt_1",
        hierarchyLevel: "team",
        personId: "prs_1",
      },
    } as unknown as Request;
    const res = makeRes();
    expect(requireDaemon(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "daemon_required",
      message: "this endpoint requires a bv_d_ token",
    });
  });

  it("requireDaemon returns true for a daemon caller (no response mutations)", () => {
    const req = {
      caller: { source: "daemon", daemonId: "dmn_1", ownerPersonId: "prs_1" },
    } as unknown as Request;
    const res = makeRes();
    expect(requireDaemon(req, res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
