import { afterEach, describe, expect, it, vi } from "vitest";
import { error, log, warn } from "./logger.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("daemon logger", () => {
  it.each([
    ["log", log, "log"],
    ["warn", warn, "warn"],
    ["error", error, "error"],
  ] as const)(
    "%s stamps an ISO timestamp and forwards every argument to console.%s",
    (_name, fn, method) => {
      const spy = vi.spyOn(console, method).mockImplementation(() => undefined);

      fn("[daemon]", "started", { id: 1 });

      expect(spy).toHaveBeenCalledTimes(1);
      const [stamp, ...rest] = spy.mock.calls[0]!;
      expect(stamp).toMatch(ISO);
      expect(rest).toEqual(["[daemon]", "started", { id: 1 }]);
    },
  );

  it("keeps the three levels on their own console channels", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    log("a");
    warn("b");
    error("c");

    expect(logSpy.mock.calls[0]!.slice(1)).toEqual(["a"]);
    expect(warnSpy.mock.calls[0]!.slice(1)).toEqual(["b"]);
    expect(errorSpy.mock.calls[0]!.slice(1)).toEqual(["c"]);
  });

  it("emits only the timestamp when called with no arguments", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    log();

    expect(spy.mock.calls[0]!).toHaveLength(1);
    expect(spy.mock.calls[0]![0]).toMatch(ISO);
  });
});
