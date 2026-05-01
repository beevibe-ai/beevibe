import { describe, it, expect } from "vitest";
import {
  deriveShortId,
  formatRelativeShort,
  formatDurationLabel,
} from "./format.js";

describe("deriveShortId", () => {
  it("strips the type prefix and keeps 6 chars", () => {
    expect(deriveShortId("sess_abc123def456")).toBe("abc123");
    expect(deriveShortId("task_zzyx99")).toBe("zzyx99");
    expect(deriveShortId("agt_xx")).toBe("xx");
  });

  it("handles ids without a prefix by truncating to 6 chars", () => {
    expect(deriveShortId("abcdefghij")).toBe("abcdef");
  });

  it("matches the web's shortId logic minus the leading '#'", () => {
    // packages/web/lib/format.ts:shortId returns "#" + first 6 chars of trimmed.
    // Our backend produces just the 6 chars (URL-friendly).
    const id = "sess_0123456789abcdef";
    expect("#" + deriveShortId(id)).toBe("#012345");
  });
});

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
});

describe("formatDurationLabel", () => {
  const now = new Date("2026-04-30T12:00:00Z");

  it("returns dash when start is missing", () => {
    expect(formatDurationLabel(null, null, now)).toBe("—");
    expect(formatDurationLabel(undefined, undefined, now)).toBe("—");
  });

  it("renders seconds under a minute", () => {
    const start = new Date(now.getTime() - 30_000);
    expect(formatDurationLabel(start, null, now)).toBe("30s");
  });

  it("renders minutes when started_at is set and completed_at is null (running)", () => {
    const start = new Date(now.getTime() - 6 * 60_000);
    expect(formatDurationLabel(start, null, now)).toBe("6m");
  });

  it("renders 'h m' when over an hour", () => {
    const start = new Date(now.getTime() - (3 * 3600_000 + 12 * 60_000));
    expect(formatDurationLabel(start, null, now)).toBe("3h 12m");
  });

  it("renders pure 'h' when minutes are zero", () => {
    const start = new Date(now.getTime() - 2 * 3600_000);
    expect(formatDurationLabel(start, null, now)).toBe("2h");
  });

  it("uses the completion time when provided rather than now", () => {
    const start = new Date("2026-04-30T10:00:00Z");
    const end = new Date("2026-04-30T11:30:00Z");
    expect(formatDurationLabel(start, end, now)).toBe("1h 30m");
  });

  it("clamps negatives to zero", () => {
    const start = new Date(now.getTime() + 10_000);
    expect(formatDurationLabel(start, null, now)).toBe("0s");
  });
});
