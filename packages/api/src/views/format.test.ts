import { describe, it, expect } from "vitest";
import { computeCacheHitRatio, formatRelativeShort } from "./format.js";

// `deriveShortId`, `formatDurationLabel`, `firstNonEmptyLine` and
// `truncate` are re-exported here verbatim from
// `@beevibe/core/domain/format` and are covered by that module's own
// suite. This file tests the two things that are actually this
// package's: the suffix-less relative-time form the wire uses, and the
// cache-hit ratio.

describe("formatRelativeShort", () => {
  const now = new Date("2026-04-30T12:00:00Z");

  it("returns 'just now' under 60s", () => {
    expect(formatRelativeShort(new Date(now.getTime() - 30_000), now)).toBe("just now");
  });

  it("uses minute granularity under an hour", () => {
    expect(formatRelativeShort(new Date(now.getTime() - 5 * 60_000), now)).toBe("5m");
  });

  it("uses hour granularity under a day", () => {
    expect(formatRelativeShort(new Date(now.getTime() - 3 * 3600_000), now)).toBe("3h");
  });

  it("uses day granularity under a month", () => {
    expect(formatRelativeShort(new Date(now.getTime() - 4 * 86400_000), now)).toBe("4d");
  });

  // The whole point of the api-local wrapper: the web renders "2m ago",
  // the wire carries the bare "2m". Same ladder, no suffix.
  it("emits the bare label with no ' ago' suffix", () => {
    expect(formatRelativeShort(new Date(now.getTime() - 2 * 60_000), now)).toBe("2m");
  });
});

describe("computeCacheHitRatio", () => {
  // The denominator is the sum of all three input slices, not `input`
  // alone — on a warm session cache_read routinely exceeds input, so
  // `cache_read / input` would report over 100%.
  it("scores cache_read against the full three-slice input total", () => {
    expect(computeCacheHitRatio({ input: 100, cacheCreation: 300, cacheRead: 600 })).toBe(0.6);
  });

  it("stays at or below 1 when cache_read dwarfs input (the warm-session case)", () => {
    const ratio = computeCacheHitRatio({ input: 10, cacheCreation: 0, cacheRead: 9_990 });
    expect(ratio).toBeLessThanOrEqual(1);
    expect(ratio).toBeCloseTo(0.999, 3);
  });

  it("returns 1 when every input token came from cache", () => {
    expect(computeCacheHitRatio({ input: 0, cacheCreation: 0, cacheRead: 500 })).toBe(1);
  });

  it("returns 0 on a cold session with no cache reads", () => {
    expect(computeCacheHitRatio({ input: 500, cacheCreation: 200, cacheRead: 0 })).toBe(0);
  });

  it("returns 0 rather than NaN when there is no input to score against", () => {
    expect(computeCacheHitRatio({ input: 0, cacheCreation: 0, cacheRead: 0 })).toBe(0);
  });
});
