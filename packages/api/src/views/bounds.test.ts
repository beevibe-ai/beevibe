import { describe, expect, it } from "vitest";
import { clampInt } from "./bounds.js";

const LIMIT = { min: 1, max: 200, fallback: 50 } as const;

describe("clampInt", () => {
  it("passes an in-band integer through", () => {
    expect(clampInt(25, LIMIT)).toBe(25);
  });

  it("clamps above the max", () => {
    expect(clampInt(9999, LIMIT)).toBe(200);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back for %s",
    (value) => {
      expect(clampInt(value, LIMIT)).toBe(50);
    },
  );

  // The bug this helper exists to close: three views clamped without
  // truncating, so `?limit=1.5` reached pg as `LIMIT '1.5'` and 500ed.
  it("truncates a fractional value toward zero", () => {
    expect(clampInt(1.9, LIMIT)).toBe(1);
    expect(clampInt(-1.9, LIMIT)).toBe(1);
  });

  it("clamps below the min by default", () => {
    expect(clampInt(0, LIMIT)).toBe(1);
    expect(clampInt(-5, LIMIT)).toBe(1);
  });

  it("falls back below the min when asked to", () => {
    const weeks = { min: 1, max: 52, fallback: 12, belowMin: "fallback" } as const;
    expect(clampInt(0, weeks)).toBe(12);
    expect(clampInt(-5, weeks)).toBe(12);
    // …but still clamps at the other end, rather than falling back there too.
    expect(clampInt(999, weeks)).toBe(52);
    expect(clampInt(8.9, weeks)).toBe(8);
  });

  it("returns the boundaries themselves untouched", () => {
    expect(clampInt(1, LIMIT)).toBe(1);
    expect(clampInt(200, LIMIT)).toBe(200);
  });
});
