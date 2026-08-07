import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  invalidBody,
  loadOwned,
  makeServiceErrorHandler,
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
  class Conflict extends Error {}
  class NarrowerConflict extends Conflict {}

  const handle = makeServiceErrorHandler("widget route", [
    [NarrowerConflict, 422, "narrower"],
    [NotFound, 404, "widget_not_found"],
    [Conflict, 409, "invalid_state"],
  ]);

  it("maps a known error to its status + code, carrying the message", () => {
    const res = fakeRes();
    handle(new NotFound("Widget w_1 not found"), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: "widget_not_found",
      message: "Widget w_1 not found",
    });
  });

  it("does not log a mapped error — it is an expected outcome", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    handle(new Conflict("already resolved"), fakeRes());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // Rows are tested in order, so a subclass listed first wins. Getting
  // this wrong would silently downgrade a narrower error to its base.
  it("takes the first matching row, so a subclass can precede its base", () => {
    const res = fakeRes();
    handle(new NarrowerConflict("nope"), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ error: "narrower" });
  });

  it("falls through to the shared 500 for an unmapped error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    handle(new Error("boom"), res, "resolve");
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", message: "boom" });
    expect(spy).toHaveBeenCalledWith("[widget route: resolve]", expect.any(Error));
    spy.mockRestore();
  });

  it("stringifies a non-Error throw on the fallback path", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    handle("just a string", res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", message: "just a string" });
    expect(spy).toHaveBeenCalledWith("[widget route]", "just a string");
    spy.mockRestore();
  });

  it("falls through when the table is empty", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    makeServiceErrorHandler("bare", [])(new NotFound("x"), res);
    expect(res.statusCode).toBe(500);
    spy.mockRestore();
  });
});
