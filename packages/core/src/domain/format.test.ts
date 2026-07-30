import { describe, expect, it } from "vitest";
import {
  deriveShortId,
  firstNonEmptyLine,
  formatDurationLabel,
  formatRelative,
  toDate,
  truncate,
} from "./format.js";

const NOW = new Date("2026-01-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("toDate", () => {
  it("passes a Date through and parses the JSON string form", () => {
    expect(toDate(NOW)).toEqual(NOW);
    expect(toDate(NOW.toISOString())).toEqual(NOW);
    expect(toDate(NOW.getTime())).toEqual(NOW);
  });

  it("returns undefined for missing or unparseable input", () => {
    expect(toDate(null)).toBeUndefined();
    expect(toDate(undefined)).toBeUndefined();
    // Would otherwise render as the literal text "Invalid Date".
    expect(toDate("not a date")).toBeUndefined();
  });
});

describe("deriveShortId", () => {
  it("strips the typed-id prefix and takes 6 chars", () => {
    expect(deriveShortId("agent_kBpTkqiCbsB3")).toBe("kBpTkq");
    expect(deriveShortId("sess_abcdef123456")).toBe("abcdef");
  });

  it("leaves an unprefixed id alone", () => {
    expect(deriveShortId("abcdefgh")).toBe("abcdef");
  });

  it("returns short ids whole rather than padding", () => {
    expect(deriveShortId("sess_abc")).toBe("abc");
  });
});

describe("truncate", () => {
  it("leaves a string at or under the cap untouched", () => {
    expect(truncate("short", 80)).toBe("short");
    expect(truncate("x".repeat(80), 80)).toBe("x".repeat(80));
  });

  it("caps at n characters INCLUDING the ellipsis", () => {
    // The contract that matters: the result is never longer than `n`,
    // so a column sized for 80 chars can't overflow by one.
    expect(truncate("x".repeat(81), 80)).toHaveLength(80);
    expect(truncate("x".repeat(200), 80).endsWith("…")).toBe(true);
  });

  it("keeps the leading n-1 characters", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("is stable on the empty string", () => {
    expect(truncate("", 80)).toBe("");
  });
});

describe("formatRelative", () => {
  it("walks every threshold in the ladder", () => {
    const at = (ms: number) => formatRelative(ago(ms), { now: NOW });
    expect(at(5 * SEC)).toBe("just now");
    expect(at(59 * SEC)).toBe("just now");
    expect(at(MIN)).toBe("1m");
    expect(at(59 * MIN)).toBe("59m");
    expect(at(HOUR)).toBe("1h");
    expect(at(23 * HOUR)).toBe("23h");
    expect(at(DAY)).toBe("1d");
    expect(at(29 * DAY)).toBe("29d");
    expect(at(30 * DAY)).toBe("1mo");
    // Months are 30-day buckets, so the year rolls at 360 days, not 365.
    expect(at(359 * DAY)).toBe("11mo");
    expect(at(360 * DAY)).toBe("1y");
  });

  it("appends the suffix to every bucket except 'just now'", () => {
    const at = (ms: number) => formatRelative(ago(ms), { now: NOW, suffix: " ago" });
    expect(at(5 * SEC)).toBe("just now");
    expect(at(2 * MIN)).toBe("2m ago");
    expect(at(3 * HOUR)).toBe("3h ago");
    expect(at(4 * DAY)).toBe("4d ago");
    expect(at(60 * DAY)).toBe("2mo ago");
    expect(at(800 * DAY)).toBe("2y ago");
  });

  it("renders a placeholder for an unparseable date", () => {
    expect(formatRelative("nonsense", { now: NOW })).toBe("—");
  });
});

describe("formatDurationLabel", () => {
  it("formats each unit band", () => {
    const from = (ms: number) => formatDurationLabel(ago(ms), NOW, NOW);
    expect(from(30 * SEC)).toBe("30s");
    expect(from(5 * MIN)).toBe("5m");
    expect(from(HOUR)).toBe("1h");
    expect(from(HOUR + 12 * MIN)).toBe("1h 12m");
    expect(from(2 * DAY + 3 * HOUR)).toBe("2d 3h");
    expect(from(2 * DAY)).toBe("2d");
  });

  it("measures against now while still running", () => {
    expect(formatDurationLabel(ago(5 * MIN), null, NOW)).toBe("5m");
  });

  it("returns a placeholder without a start", () => {
    expect(formatDurationLabel(null, NOW, NOW)).toBe("—");
  });

  it("clamps a completion that precedes the start to zero", () => {
    expect(formatDurationLabel(NOW, ago(MIN), NOW)).toBe("0s");
  });
});

describe("firstNonEmptyLine", () => {
  it("skips leading blank and whitespace-only lines", () => {
    expect(firstNonEmptyLine("\n \n  Ships infra  \nmore")).toBe("Ships infra");
  });

  it("returns undefined when there is nothing renderable", () => {
    expect(firstNonEmptyLine("   \n\t\n ")).toBeUndefined();
    expect(firstNonEmptyLine("")).toBeUndefined();
    expect(firstNonEmptyLine(null)).toBeUndefined();
  });
});
