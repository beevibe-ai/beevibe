import { afterEach, describe, expect, it, vi } from "vitest";
import { error, log, warn } from "./logger.js";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("log() writes to console.log with an ISO timestamp prefix and the args", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("hello", 42);
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]!;
    expect(call[0]).toMatch(ISO_TIMESTAMP);
    expect(call.slice(1)).toEqual(["hello", 42]);
  });

  it("warn() writes to console.warn (not console.log) with an ISO timestamp", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warn("something", { detail: "yep" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const call = warnSpy.mock.calls[0]!;
    expect(call[0]).toMatch(ISO_TIMESTAMP);
    expect(call.slice(1)).toEqual(["something", { detail: "yep" }]);
  });

  it("error() writes to console.error (not console.warn/log) with an ISO timestamp", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const boom = new Error("boom");
    error("uh oh", boom);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    const call = errorSpy.mock.calls[0]!;
    expect(call[0]).toMatch(ISO_TIMESTAMP);
    expect(call.slice(1)).toEqual(["uh oh", boom]);
  });

  it("no-arg calls still emit exactly the timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toHaveLength(1);
    expect(spy.mock.calls[0]![0]).toMatch(ISO_TIMESTAMP);
  });
});
