import { describe, expect, it } from "vitest";
import { clampLimit, parseLimit, type LimitBounds } from "./pagination.js";

const BOUNDS: LimitBounds = { fallback: 50, max: 200 };

describe("clampLimit", () => {
  it("passes an in-band value through untouched", () => {
    expect(clampLimit(75, BOUNDS)).toBe(75);
  });

  it("takes the fallback when there is no value", () => {
    expect(clampLimit(undefined, BOUNDS)).toBe(50);
  });

  it.each([NaN, Infinity, -Infinity])("takes the fallback for %p", (value) => {
    expect(clampLimit(value, BOUNDS)).toBe(50);
  });

  it("clamps to the ceiling rather than dropping to the fallback", () => {
    // The divergence this settles: `/view/inbox` used to answer ?limit=201
    // with 50 rows. Serving the most we serve is the better reading of
    // "more than we serve".
    expect(clampLimit(201, BOUNDS)).toBe(200);
    expect(clampLimit(1e9, BOUNDS)).toBe(200);
  });

  it("clamps up to the floor, never serving a zero- or negative-row page", () => {
    expect(clampLimit(0, BOUNDS)).toBe(1);
    expect(clampLimit(-5, BOUNDS)).toBe(1);
  });

  it("honours an explicit min over the default floor of 1", () => {
    expect(clampLimit(2, { fallback: 50, max: 200, min: 10 })).toBe(10);
  });

  it("floors a fractional limit instead of handing it to Postgres", () => {
    // `LIMIT $n` is a bigint. None of the hand-written copies floored, so a
    // fractional limit reached pg as "1.5" and 500ed the endpoint.
    expect(clampLimit(1.5, BOUNDS)).toBe(1);
    expect(clampLimit(199.9, BOUNDS)).toBe(199);
  });

  it("is idempotent, so a route and its view may both apply it", () => {
    expect(clampLimit(clampLimit(1e9, BOUNDS), BOUNDS)).toBe(200);
    expect(clampLimit(clampLimit(undefined, BOUNDS), BOUNDS)).toBe(50);
  });
});

describe("parseLimit", () => {
  it("reads a numeric string", () => {
    expect(parseLimit("120")).toBe(120);
  });

  it("hands back undefined when the param is absent", () => {
    expect(parseLimit(undefined)).toBeUndefined();
  });

  it("hands back undefined for a non-numeric string", () => {
    expect(parseLimit("abc")).toBeUndefined();
  });

  it.each(["", "   ", "\t"])("treats a blank %j as absent, not as zero", (raw) => {
    // `Number("")` is 0 and 0 is finite, so the hand-written checks let an
    // empty param through as a real request: `/view/promotion?limit=`
    // answered with a single row.
    expect(parseLimit(raw)).toBeUndefined();
  });

  it.each([
    ["array", ["5", "6"]],
    ["object", { a: "1" }],
    ["number", 5],
  ])("treats a non-string %s query value as absent", (_label, raw) => {
    // Express types `req.query.x` as string | string[] | ParsedQs; a
    // repeated ?limit=1&limit=2 segment must not reach Number().
    expect(parseLimit(raw)).toBeUndefined();
  });

  it("does not bound the value — that is the band owner's call", () => {
    // Separating the halves is what lets a route stay ignorant of a
    // resource's page size while the view that owns the query owns the band.
    expect(parseLimit("999")).toBe(999);
    expect(parseLimit("0")).toBe(0);
    expect(parseLimit("-3")).toBe(-3);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseLimit(" 30 ")).toBe(30);
  });
});
