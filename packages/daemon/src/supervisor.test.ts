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

  it("cancelAll() on an idle supervisor is a no-op", () => {
    const s = new Supervisor(2);
    expect(() => s.cancelAll()).not.toThrow();
    expect(s.inFlight()).toBe(0);
    expect(s.hasCapacity()).toBe(true);
  });

  it("finish() on an unknown session leaves the in-flight set alone", () => {
    const s = new Supervisor(2);
    s.start("sess_1");
    s.finish("sess_ghost");
    expect(s.inFlight()).toBe(1);
  });

  describe("cap from the environment", () => {
    const ENV = "BEEVIBE_DAEMON_MAX_CONCURRENT";
    const original = process.env[ENV];

    afterEach(() => {
      if (original === undefined) delete process.env[ENV];
      else process.env[ENV] = original;
    });

    function capOf(s: Supervisor): number {
      let n = 0;
      while (s.hasCapacity()) {
        s.start(`sess_${n}`);
        n++;
        if (n > DEFAULT_MAX_CONCURRENT + 5) break;
      }
      return n;
    }

    it("reads an explicit override", () => {
      process.env[ENV] = "3";
      expect(capOf(new Supervisor())).toBe(3);
    });

    it("tolerates trailing junk the way parseInt does", () => {
      process.env[ENV] = "4abc";
      expect(capOf(new Supervisor())).toBe(4);
    });

    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["zero", "0"],
      ["negative", "-2"],
      ["non-numeric", "lots"],
    ])("falls back to the default when %s", (_label, raw) => {
      if (raw === undefined) delete process.env[ENV];
      else process.env[ENV] = raw;
      expect(capOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
    });

    it("an explicit constructor argument beats the env var", () => {
      process.env[ENV] = "99";
      expect(capOf(new Supervisor(2))).toBe(2);
    });
  });
});
