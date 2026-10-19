import { afterEach, describe, expect, it, vi } from "vitest";
import { error, log, warn } from "./logger.js";

/** ISO-8601 with milliseconds, as `Date#toISOString` emits. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["log", log, "log"],
    ["warn", warn, "warn"],
    ["error", error, "error"],
  ] as const)("%s prefixes an ISO timestamp on the matching console method", (
    _name,
    fn,
    method,
  ) => {
    const spy = vi.spyOn(console, method).mockImplementation(() => {});
    fn("claimed", { session: "sess_1" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [stamp, ...rest] = spy.mock.calls[0]!;
    expect(stamp).toMatch(ISO);
    // Arguments are forwarded verbatim — no formatting, no stringifying,
    // so console keeps its own object inspection.
    expect(rest).toEqual(["claimed", { session: "sess_1" }]);
  });

  it("forwards a bare call with only the timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log();
    expect(spy.mock.calls[0]).toHaveLength(1);
    expect(spy.mock.calls[0]![0]).toMatch(ISO);
  });

  it("does not cross-post to the other console methods", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    warn("heads up");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
