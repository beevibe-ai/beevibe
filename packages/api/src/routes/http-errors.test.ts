import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  invalidBody,
  loadOwned,
  makeServiceErrorHandler,
  readIntQuery,
  readStringQuery,
  requireNullableString,
  requireParam,
} from "./http-errors.js";

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: unknown };
}

function fakeReq(params: Record<string, unknown>): Request {
  return { params } as unknown as Request;
}

function fakeBodyReq(body: unknown): Request {
  return { body } as unknown as Request;
}

function fakeQueryReq(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe("requireParam", () => {
  it("returns the param and answers nothing when present", () => {
    const res = fakeRes();
    expect(requireParam(fakeReq({ id: "agent_123" }), res, "id", "missing_agent_id")).toBe(
      "agent_123",
    );
    expect(res.statusCode).toBeUndefined();
  });

  it("400s with the caller's own error code, not a generic one", () => {
    // The codes are already in the wire contract and clients may branch
    // on them, so the helper factors out the shape but never the code.
    const res = fakeRes();
    expect(requireParam(fakeReq({}), res, "id", "missing_task_id")).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "missing_task_id" });
  });

  it("treats an empty segment as missing", () => {
    const res = fakeRes();
    expect(requireParam(fakeReq({ id: "" }), res, "id", "missing_id")).toBeUndefined();
    expect(res.statusCode).toBe(400);
  });

  it("rejects an array-valued param rather than handing back an array", () => {
    // Express 5 types params as `string | string[]`; a repeated segment
    // must not reach a handler that expects a string.
    const res = fakeRes();
    expect(requireParam(fakeReq({ id: ["a", "b"] }), res, "id", "missing_id")).toBeUndefined();
    expect(res.statusCode).toBe(400);
  });
});

describe("loadOwned", () => {
  const agent = { id: "agent_1", owner_id: "person_1" };

  it("returns the entity when the caller owns it", async () => {
    const res = fakeRes();
    const got = await loadOwned(
      res,
      "person_1",
      () => Promise.resolve(agent),
      (a) => a.owner_id,
      "agent_not_found",
    );
    expect(got).toBe(agent);
    expect(res.statusCode).toBeUndefined();
  });

  it("404s with the caller's code when the row is missing", async () => {
    const res = fakeRes();
    const got = await loadOwned(
      res,
      "person_1",
      () => Promise.resolve(undefined),
      (a: typeof agent) => a.owner_id,
      "agent_not_found",
    );
    expect(got).toBeUndefined();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "agent_not_found" });
  });

  it("403s when the row belongs to somebody else", async () => {
    // The half that's easy to forget when this is written out by hand —
    // forgetting it is a cross-tenant read.
    const res = fakeRes();
    const got = await loadOwned(
      res,
      "person_OTHER",
      () => Promise.resolve(agent),
      (a) => a.owner_id,
      "agent_not_found",
    );
    expect(got).toBeUndefined();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "not_owner" });
  });

  it("can answer non-owners with the not-found shape instead", async () => {
    // What `runtimes` does: don't confirm that a daemon id exists.
    const res = fakeRes();
    const got = await loadOwned(
      res,
      "person_OTHER",
      () => Promise.resolve({ id: "rt_1", owner_person_id: "person_1" }),
      (d) => d.owner_person_id,
      "daemon_not_found",
      { status: 404, error: "daemon_not_found" },
    );
    expect(got).toBeUndefined();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "daemon_not_found" });
  });

  it("treats a null owner column as not-owned", async () => {
    const res = fakeRes();
    const got = await loadOwned(
      res,
      "person_1",
      () => Promise.resolve({ id: "x", owner_id: null }),
      (e) => e.owner_id,
      "not_found",
    );
    expect(got).toBeUndefined();
    expect(res.statusCode).toBe(403);
  });

  it("does not call the loader more than once", async () => {
    const load = vi.fn().mockResolvedValue(agent);
    await loadOwned(fakeRes(), "person_1", load, (a: typeof agent) => a.owner_id, "nf");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("invalidBody", () => {
  it("400s with the invalid_body envelope and the caller's message", () => {
    const res = fakeRes();
    invalidBody(res, "expected { content: string }");
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "invalid_body",
      message: "expected { content: string }",
    });
  });

  // The wording is the only part a client sees and it is not uniform
  // across routers, so the helper factors out the envelope, not the prose.
  it("passes the message through verbatim", () => {
    const res = fakeRes();
    invalidBody(res, "name, goal_pattern, repo_run_id required");
    expect(res.body).toMatchObject({
      message: "name, goal_pattern, repo_run_id required",
    });
  });
});

describe("requireNullableString", () => {
  it("returns a non-empty string and answers nothing", () => {
    const res = fakeRes();
    expect(requireNullableString(fakeBodyReq({ model: "opus" }), res, "model")).toBe("opus");
    expect(res.statusCode).toBeUndefined();
  });

  // null is a VALID value here — it clears the column — so it must come
  // back as null rather than being lumped in with the reject case.
  it("returns null for an explicit null without responding", () => {
    const res = fakeRes();
    expect(requireNullableString(fakeBodyReq({ model: null }), res, "model")).toBeNull();
    expect(res.statusCode).toBeUndefined();
  });

  it("400s when the field is absent", () => {
    const res = fakeRes();
    expect(requireNullableString(fakeBodyReq({}), res, "model")).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "invalid_body",
      message: "expected { model: string | null }",
    });
  });

  it("400s on an empty string rather than binding it", () => {
    const res = fakeRes();
    expect(requireNullableString(fakeBodyReq({ runtime_id: "" }), res, "runtime_id")).toBeUndefined();
    expect(res.statusCode).toBe(400);
  });

  it("400s on a non-string, non-null type", () => {
    const res = fakeRes();
    expect(requireNullableString(fakeBodyReq({ model: 7 }), res, "model")).toBeUndefined();
    expect(res.statusCode).toBe(400);
  });

  it("400s when there is no body at all", () => {
    const res = fakeRes();
    expect(requireNullableString(fakeBodyReq(undefined), res, "model")).toBeUndefined();
    expect(res.statusCode).toBe(400);
  });

  it("names the field it was asked for in the message", () => {
    const res = fakeRes();
    requireNullableString(fakeBodyReq({}), res, "runtime_id");
    expect(res.body).toMatchObject({
      message: "expected { runtime_id: string | null }",
    });
  });
});

describe("makeServiceErrorHandler", () => {
  class NotFound extends Error {}
  class BadState extends Error {}
  class Unrelated extends Error {}

  const handle = makeServiceErrorHandler("test route", [
    { is: NotFound, status: 404, error: "thing_not_found" },
    { is: BadState, status: 409, error: "invalid_state" },
  ]);

  it("maps a listed error to its status and code, keeping the thrown message", () => {
    const res = fakeRes();
    handle(new NotFound("no such thing: t_1"), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "thing_not_found", message: "no such thing: t_1" });
  });

  it("walks the whole table, not just the first row", () => {
    const res = fakeRes();
    handle(new BadState("already closed"), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "invalid_state", message: "already closed" });
  });

  it("falls through to the shared 500 for an unlisted error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    handle(new Unrelated("connection reset"), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", message: "connection reset" });
    expect(spy.mock.calls[0]![0]).toBe("[test route]");
    spy.mockRestore();
  });

  it("stringifies a non-Error throw on the fallback path", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    handle("just a string", res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", message: "just a string" });
    spy.mockRestore();
  });

  it("prefers the first matching row when an error subclasses another", () => {
    // Ordering is the table's contract: escalation lists both of its
    // not-found errors before the 409, and a subclass must not be
    // swallowed by a base class listed above it.
    class Specific extends NotFound {}
    const ordered = makeServiceErrorHandler("test route", [
      { is: Specific, status: 410, error: "gone" },
      { is: NotFound, status: 404, error: "thing_not_found" },
    ]);
    const res = fakeRes();
    ordered(new Specific("x"), res);
    expect(res.statusCode).toBe(410);
  });
});

describe("readIntQuery", () => {
  it("returns undefined for an absent param when there is no fallback", () => {
    expect(readIntQuery(fakeQueryReq({}), "limit")).toBeUndefined();
  });

  it("returns undefined for a non-numeric value when there is no fallback", () => {
    expect(readIntQuery(fakeQueryReq({ limit: "abc" }), "limit")).toBeUndefined();
  });

  it("ignores a repeated param, which Express hands back as an array", () => {
    expect(readIntQuery(fakeQueryReq({ limit: ["1", "2"] }), "limit", { fallback: 7 })).toBe(7);
  });

  it("uses the fallback when the value is out of range", () => {
    const req = fakeQueryReq({ limit: "500" });
    expect(readIntQuery(req, "limit", { fallback: 50, min: 1, max: 200 })).toBe(50);
  });

  it("passes an in-range value straight through", () => {
    const req = fakeQueryReq({ limit: "120" });
    expect(readIntQuery(req, "limit", { fallback: 50, min: 1, max: 200 })).toBe(120);
  });

  it("clamps to the nearest bound when asked to", () => {
    const opts = { fallback: 5, min: 1, max: 10, onOutOfRange: "clamp" } as const;
    expect(readIntQuery(fakeQueryReq({ limit: "50" }), "limit", opts)).toBe(10);
    expect(readIntQuery(fakeQueryReq({ limit: "0" }), "limit", opts)).toBe(1);
  });

  it("floors a fractional value in clamp mode, as /find-repo always did", () => {
    const opts = { fallback: 5, min: 1, max: 10, onOutOfRange: "clamp" } as const;
    expect(readIntQuery(fakeQueryReq({ limit: "3.7" }), "limit", opts)).toBe(3);
  });

  it("falls back for a missing param even in clamp mode", () => {
    const opts = { fallback: 5, min: 1, max: 10, onOutOfRange: "clamp" } as const;
    expect(readIntQuery(fakeQueryReq({}), "limit", opts)).toBe(5);
  });
});

describe("readStringQuery", () => {
  it("trims the value", () => {
    expect(readStringQuery(fakeQueryReq({ goal: "  ship it  " }), "goal")).toBe("ship it");
  });

  it("returns empty string for absent, blank, or repeated params", () => {
    expect(readStringQuery(fakeQueryReq({}), "goal")).toBe("");
    expect(readStringQuery(fakeQueryReq({ goal: "   " }), "goal")).toBe("");
    expect(readStringQuery(fakeQueryReq({ goal: ["a", "b"] }), "goal")).toBe("");
  });
});
