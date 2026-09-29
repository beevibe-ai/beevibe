/**
 * The daemon's log helpers exist to stamp every line with an ISO
 * timestamp — `/tmp/beevibe-daemon.log` is read by hand when a spawn
 * misbehaves, and untimed lines are useless there. These tests pin the
 * prefix and that the arguments pass through unflattened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { error, log, warn } from "./logger.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ["log", log, "log"] as const,
  ["warn", warn, "warn"] as const,
  ["error", error, "error"] as const,
])("%s", (_name, fn, consoleMethod) => {
  it("prefixes an ISO-8601 timestamp", () => {
    const spy = vi.spyOn(console, consoleMethod).mockImplementation(() => {});
    fn("spawned", "sess_1");
    expect(spy).toHaveBeenCalledOnce();
    const args = spy.mock.calls[0]!;
    expect(args[0]).toMatch(ISO);
    expect(args.slice(1)).toEqual(["spawned", "sess_1"]);
  });

  it("passes non-string arguments through without stringifying them", () => {
    const spy = vi.spyOn(console, consoleMethod).mockImplementation(() => {});
    const payload = { sessionId: "sess_1", pid: 42 };
    const err = new Error("boom");
    fn(payload, err);
    const args = spy.mock.calls[0]!;
    expect(args[1]).toBe(payload);
    expect(args[2]).toBe(err);
  });

  it("emits just the timestamp when called with no arguments", () => {
    const spy = vi.spyOn(console, consoleMethod).mockImplementation(() => {});
    fn();
    expect(spy.mock.calls[0]).toHaveLength(1);
    expect(spy.mock.calls[0]![0]).toMatch(ISO);
  });

  it("stamps the time of the call, not of module load", () => {
    const spy = vi.spyOn(console, consoleMethod).mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-02T03:04:05.678Z"));
      fn("x");
      expect(spy.mock.calls[0]![0]).toBe("2024-01-02T03:04:05.678Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
