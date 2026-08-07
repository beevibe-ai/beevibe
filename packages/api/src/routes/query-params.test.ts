import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { numericQuery } from "./query-params.js";

function req(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

const BAND = { min: 1, max: 200, fallback: 50 } as const;

describe("numericQuery", () => {
  it("reads an in-band value", () => {
    expect(numericQuery(req({ limit: "25" }), "limit", BAND)).toBe(25);
  });

  it.each(["0", "-5", "201", "abc"])("falls back for an out-of-band %j", (limit) => {
    expect(numericQuery(req({ limit }), "limit", BAND)).toBe(50);
  });

  it("falls back when the param is absent", () => {
    expect(numericQuery(req({}), "limit", BAND)).toBe(50);
  });

  // Express hands back an array for a repeated param. Number(["1","2"]) is
  // NaN, but the typeof guard rejects it before that ever matters.
  it("falls back when the param is repeated", () => {
    expect(numericQuery(req({ limit: ["1", "2"] }), "limit", BAND)).toBe(50);
  });

  it("returns undefined with no fallback configured", () => {
    expect(numericQuery(req({}), "limit")).toBeUndefined();
    expect(numericQuery(req({ limit: "abc" }), "limit")).toBeUndefined();
  });

  // `/promotion` and `/memory/fact` pass the raw number down to a view that
  // owns the clamp, so an unbounded read must not invent bounds of its own.
  it("passes any finite value through when unbounded", () => {
    expect(numericQuery(req({ limit: "" }), "limit")).toBe(0);
    expect(numericQuery(req({ limit: "-9" }), "limit")).toBe(-9);
    expect(numericQuery(req({ limit: "1e6" }), "limit")).toBe(1_000_000);
  });

  it("honours a one-sided band", () => {
    expect(numericQuery(req({ weeks: "999" }), "weeks", { min: 1, fallback: 12 })).toBe(999);
    expect(numericQuery(req({ weeks: "" }), "weeks", { min: 1, fallback: 12 })).toBe(12);
  });

  it("does not truncate — that is clampInt's job", () => {
    expect(numericQuery(req({ limit: "3.9" }), "limit", BAND)).toBe(3.9);
  });
});
