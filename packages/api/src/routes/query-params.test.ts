import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import {
  boundedFloorIntQuery,
  boundedIntQuery,
  enumQuery,
  numberQuery,
  requireStringQuery,
  stringQuery,
} from "./query-params.js";

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

function fakeReq(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe("stringQuery", () => {
  it("returns a single string value verbatim, untrimmed", () => {
    expect(stringQuery(fakeReq({ view: " mine " }), "view")).toBe(" mine ");
  });

  it("is undefined when absent", () => {
    expect(stringQuery(fakeReq({}), "view")).toBeUndefined();
  });

  it("is undefined for a repeated param, which Express hands back as an array", () => {
    expect(stringQuery(fakeReq({ view: ["all", "mine"] }), "view")).toBeUndefined();
  });
});

describe("requireStringQuery", () => {
  it("returns the trimmed value and answers nothing when present", () => {
    const res = fakeRes();
    expect(requireStringQuery(fakeReq({ goal: "  add tests  " }), res, "goal", "missing_goal")).toBe(
      "add tests",
    );
    expect(res.statusCode).toBeUndefined();
  });

  it.each([{}, { goal: "" }, { goal: "   " }, { goal: ["a", "b"] }])(
    "400s with the given code for %j",
    (query) => {
      const res = fakeRes();
      expect(requireStringQuery(fakeReq(query), res, "goal", "missing_goal")).toBeUndefined();
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "missing_goal" });
    },
  );
});

describe("numberQuery", () => {
  it("parses a finite number", () => {
    expect(numberQuery(fakeReq({ limit: "5" }), "limit")).toBe(5);
  });

  it("keeps a fraction and a negative — bounds are the caller's business", () => {
    expect(numberQuery(fakeReq({ limit: "2.5" }), "limit")).toBe(2.5);
    expect(numberQuery(fakeReq({ limit: "-5" }), "limit")).toBe(-5);
  });

  it.each(["abc", "Infinity"])("is undefined for the unparseable %j", (limit) => {
    expect(numberQuery(fakeReq({ limit }), "limit")).toBeUndefined();
  });

  it("is undefined when absent", () => {
    expect(numberQuery(fakeReq({}), "limit")).toBeUndefined();
  });

  it("reads an empty value as an explicit 0, since Number('') is 0", () => {
    // Pinned as the existing behavior of /promotion and /memory/fact,
    // not endorsed — both let the view layer apply the lower bound.
    expect(numberQuery(fakeReq({ limit: "" }), "limit")).toBe(0);
  });
});

describe("boundedIntQuery", () => {
  const opts = { max: 200, fallback: 50 };

  it("honours a value inside the band", () => {
    expect(boundedIntQuery(fakeReq({ limit: "200" }), "limit", opts)).toBe(200);
    expect(boundedIntQuery(fakeReq({ limit: "1" }), "limit", opts)).toBe(1);
  });

  it.each(["0", "-5", "201", "abc", ""])(
    "falls back rather than clamping for the out-of-band %j",
    (limit) => {
      expect(boundedIntQuery(fakeReq({ limit }), "limit", opts)).toBe(50);
    },
  );

  it("falls back when absent", () => {
    expect(boundedIntQuery(fakeReq({}), "limit", opts)).toBe(50);
  });
});

describe("boundedFloorIntQuery", () => {
  const opts = { min: 1, max: 10, fallback: 5 };

  it("clamps to the nearest bound instead of falling back", () => {
    expect(boundedFloorIntQuery(fakeReq({ limit: "50" }), "limit", opts)).toBe(10);
    expect(boundedFloorIntQuery(fakeReq({ limit: "0" }), "limit", opts)).toBe(1);
    expect(boundedFloorIntQuery(fakeReq({ limit: "-5" }), "limit", opts)).toBe(1);
  });

  it("floors a fraction", () => {
    expect(boundedFloorIntQuery(fakeReq({ limit: "3.7" }), "limit", opts)).toBe(3);
  });

  it.each([{}, { limit: "abc" }])("falls back for %j", (query) => {
    expect(boundedFloorIntQuery(fakeReq(query), "limit", opts)).toBe(5);
  });
});

describe("enumQuery", () => {
  const SCOPES = new Set(["ic", "team", "org"] as const);

  it("returns a recognized member", () => {
    expect(enumQuery(fakeReq({ scope: "team" }), "scope", SCOPES)).toBe("team");
  });

  it.each([{ scope: "galaxy" }, { scope: "" }, {}, { scope: ["ic", "org"] }])(
    "is undefined for %j",
    (query) => {
      expect(enumQuery(fakeReq(query), "scope", SCOPES)).toBeUndefined();
    },
  );
});
