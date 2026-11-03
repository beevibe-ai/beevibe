import { describe, expect, it } from "vitest";
import { clampLimit } from "./pagination.js";

const opts = { fallback: 50, max: 200 };

describe("clampLimit", () => {
  it("passes an in-range value through", () => {
    expect(clampLimit(25, opts)).toBe(25);
  });

  it("defaults when the caller supplied nothing", () => {
    expect(clampLimit(undefined, opts)).toBe(50);
  });

  it("caps at max and floors at 1", () => {
    expect(clampLimit(5_000, opts)).toBe(200);
    expect(clampLimit(0, opts)).toBe(1);
    expect(clampLimit(-10, opts)).toBe(1);
  });

  it("honours an explicit min", () => {
    expect(clampLimit(1, { ...opts, min: 10 })).toBe(10);
  });

  /**
   * The three view copies this replaced ran
   * `Math.min(Math.max(1, limit ?? DEFAULT), MAX)` with no finiteness
   * guard, so these two cases reached the `LIMIT $n` binding as `NaN` and
   * `2.7` — Postgres rejects both.
   */
  it("falls back on a non-finite value instead of propagating it", () => {
    expect(clampLimit(Number.NaN, opts)).toBe(50);
    expect(clampLimit(Number.POSITIVE_INFINITY, opts)).toBe(50);
  });

  it("truncates a fractional value to an integer", () => {
    expect(clampLimit(2.7, opts)).toBe(2);
    expect(Number.isInteger(clampLimit(199.999, opts))).toBe(true);
  });

  it("clamps the fallback itself when it sits outside the range", () => {
    expect(clampLimit(undefined, { fallback: 999, max: 200 })).toBe(200);
  });
});
