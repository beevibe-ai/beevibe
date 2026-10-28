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
  const saved = process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;

  afterEach(() => {
    if (saved === undefined) delete process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;
    else process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = saved;
  });

  /** Fill the supervisor to find the cap it actually enforces. */
  function capacityOf(s: Supervisor): number {
    let n = 0;
    while (s.hasCapacity() && n < 1000) {
      s.start(`sess_${n}`);
      n += 1;
    }
    return n;
  }

  it("uses DEFAULT_MAX_CONCURRENT when the env var is unset", () => {
    delete process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;
    expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("honours a valid override", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "2";
    expect(capacityOf(new Supervisor())).toBe(2);
  });

  it("falls back to the default for an empty value", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "";
    expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("falls back to the default for a non-numeric value", () => {
    // A typo in the env must not silently cap the daemon at NaN, which
    // would make hasCapacity() false forever and wedge every spawn.
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "lots";
    expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("falls back to the default for zero and negative values", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "0";
    expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "-4";
    expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("takes the leading integer of a decimal value", () => {
    // parseInt semantics — documented here so a change to Number() is a
    // deliberate choice rather than a surprise.
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "3.9";
    expect(capacityOf(new Supervisor())).toBe(3);
  });

  it("an explicit constructor argument wins over the env var", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "9";
    expect(capacityOf(new Supervisor(1))).toBe(1);
  });
});
