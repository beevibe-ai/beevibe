import { describe, expect, it } from "vitest";
import { clampLimit } from "./limits.js";

describe("clampLimit", () => {
  const opts = { fallback: 100, max: 500 };

  it("substitutes the fallback for an absent limit", () => {
    expect(clampLimit(undefined, opts)).toBe(100);
  });

  it("passes a value inside the band through", () => {
    expect(clampLimit(250, opts)).toBe(250);
  });

  it("clamps to the nearest bound rather than falling back", () => {
    expect(clampLimit(0, opts)).toBe(1);
    expect(clampLimit(-5, opts)).toBe(1);
    expect(clampLimit(5000, opts)).toBe(500);
  });

  it("leaves a fraction alone — Postgres rounds it at the LIMIT", () => {
    expect(clampLimit(2.5, opts)).toBe(2.5);
  });
});
