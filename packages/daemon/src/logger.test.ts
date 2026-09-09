/**
 * The daemon's only logging surface. Every `[daemon] …` line an operator
 * reads out of /tmp/beevibe-daemon.log goes through here, and the
 * ISO-timestamp prefix is what makes those lines greppable by time —
 * so the prefix is a contract, not decoration.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { error, log, warn } from "./logger.js";

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger", () => {
  it("log() writes to console.log with an ISO timestamp first", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log("[daemon] started");
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0] ?? [];
    expect(String(args[0])).toMatch(ISO_8601);
    expect(args[1]).toBe("[daemon] started");
  });

  // warn/error must not collapse onto console.log: operators separate
  // the daemon's stdout from its stderr when running it under a
  // supervisor, so the stream a line lands on is observable behavior.
  it("warn() writes to console.warn, not console.log", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warn("[daemon] skills sync failed;", "continuing");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.mock.calls[0] ?? [];
    expect(String(args[0])).toMatch(ISO_8601);
    expect(args.slice(1)).toEqual(["[daemon] skills sync failed;", "continuing"]);
  });

  it("error() writes to console.error, not console.log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    error("[daemon] claim failed");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String((errSpy.mock.calls[0] ?? [])[0])).toMatch(ISO_8601);
  });

  it("forwards every variadic argument after the timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = new Error("boom");
    log("a", 1, { b: 2 }, err);
    expect((spy.mock.calls[0] ?? []).slice(1)).toEqual(["a", 1, { b: 2 }, err]);
  });

  it("stamps the time of the call, not of module load", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      log("first");
      vi.setSystemTime(new Date("2024-01-01T00:05:00.000Z"));
      log("second");
    } finally {
      vi.useRealTimers();
    }
    expect((spy.mock.calls[0] ?? [])[0]).toBe("2024-01-01T00:00:00.000Z");
    expect((spy.mock.calls[1] ?? [])[0]).toBe("2024-01-01T00:05:00.000Z");
  });
});
