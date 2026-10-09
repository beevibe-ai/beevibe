/**
 * The timestamp prefix is the whole contract here: `tail -f
 * /tmp/beevibe-daemon.log` is the primary debugging surface for a
 * running daemon, and correlating a spawn against an api-side session
 * needs the time on every line. Each level must also land on its own
 * console channel so stderr stays usable as an error filter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { error, log, warn } from "./logger.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("daemon logger", () => {
  it.each([
    ["log", log, "log"] as const,
    ["warn", warn, "warn"] as const,
    ["error", error, "error"] as const,
  ])("%s prefixes an ISO timestamp and forwards every arg", (_name, fn, channel) => {
    const spy = vi.spyOn(console, channel).mockImplementation(() => {});

    fn("spawning", { agent: "agent_1" }, 7);

    expect(spy).toHaveBeenCalledTimes(1);
    const [stamp, ...rest] = spy.mock.calls[0]!;
    expect(stamp).toMatch(ISO);
    expect(rest).toEqual(["spawning", { agent: "agent_1" }, 7]);
  });

  it("writes each level to its own console channel", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    log("a");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    warn("b");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();

    error("c");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("emits a bare timestamp when called with no args", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log();
    expect(spy.mock.calls[0]).toHaveLength(1);
    expect(spy.mock.calls[0]![0]).toMatch(ISO);
  });

  it("stamps the time of the call, not of module load", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
      log("first");
      vi.setSystemTime(new Date("2026-03-01T00:05:00.000Z"));
      log("second");
    } finally {
      vi.useRealTimers();
    }
    expect(spy.mock.calls[0]![0]).toBe("2026-03-01T00:00:00.000Z");
    expect(spy.mock.calls[1]![0]).toBe("2026-03-01T00:05:00.000Z");
  });
});
