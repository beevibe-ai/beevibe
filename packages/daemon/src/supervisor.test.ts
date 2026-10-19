import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_CONCURRENT, Supervisor } from "./supervisor.js";

describe("Supervisor", () => {
  it("respects maxConcurrent: hasCapacity flips to false at the cap", () => {
    const s = new Supervisor(2);
    expect(s.hasCapacity()).toBe(true);
    s.start("sess_1");
    s.start("sess_2");
    expect(s.hasCapacity()).toBe(false);
    expect(() => s.start("sess_3")).toThrow(/at capacity/);
  });

  it("finish() frees a slot", () => {
    const s = new Supervisor(1);
    s.start("sess_1");
    expect(s.hasCapacity()).toBe(false);
    s.finish("sess_1");
    expect(s.hasCapacity()).toBe(true);
    expect(s.inFlight()).toBe(0);
  });

  it("cancel(id) aborts the controller and returns true", () => {
    const s = new Supervisor(1);
    const ctrl = s.start("sess_1");
    let aborted = false;
    ctrl.signal.addEventListener("abort", () => {
      aborted = true;
    });
    expect(s.cancel("sess_1")).toBe(true);
    expect(aborted).toBe(true);
  });

  it("cancel(id) returns false for unknown sessions", () => {
    const s = new Supervisor(1);
    expect(s.cancel("sess_ghost")).toBe(false);
  });

  it("cancelAll() aborts every in-flight controller", () => {
    const s = new Supervisor(3);
    const ctrls = [s.start("a"), s.start("b"), s.start("c")];
    let abortCount = 0;
    for (const ctrl of ctrls) {
      ctrl.signal.addEventListener("abort", () => abortCount++);
    }
    s.cancelAll();
    expect(abortCount).toBe(3);
    expect(s.inFlight()).toBe(0);
  });
});

describe("Supervisor default cap (BEEVIBE_DAEMON_MAX_CONCURRENT)", () => {
  const original = process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;

  afterEach(() => {
    if (original === undefined) delete process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;
    else process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = original;
  });

  /** Fill the supervisor until it refuses, and report how many fit. */
  function capacityOf(s: Supervisor): number {
    let n = 0;
    while (s.hasCapacity()) {
      s.start(`sess_${n}`);
      n++;
      if (n > DEFAULT_MAX_CONCURRENT + 5) throw new Error("cap never reached");
    }
    return n;
  }

  it("falls back to DEFAULT_MAX_CONCURRENT when the env var is unset", () => {
    delete process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;
    expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("reads a valid override from the env", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "3";
    expect(capacityOf(new Supervisor())).toBe(3);
  });

  it.each(["", "abc", "0", "-1"])(
    "ignores the unusable override %j and keeps the default",
    (raw) => {
      process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = raw;
      expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
    },
  );

  it("truncates a fractional override the way parseInt does", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "2.9";
    expect(capacityOf(new Supervisor())).toBe(2);
  });
});
