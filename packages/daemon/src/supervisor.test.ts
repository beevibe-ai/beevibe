import { describe, expect, it } from "vitest";
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

/**
 * The no-arg constructor reads BEEVIBE_DAEMON_MAX_CONCURRENT. A bad
 * value must not silently become a cap of 0 (which would wedge the
 * daemon: hasCapacity() false forever, so nothing ever dispatches).
 */
describe("Supervisor — BEEVIBE_DAEMON_MAX_CONCURRENT", () => {
  const KEY = "BEEVIBE_DAEMON_MAX_CONCURRENT";

  function withEnv(value: string | undefined, fn: () => void): void {
    const prev = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }

  /** Fill to the cap to observe it, since maxConcurrent is private. */
  function capacityOf(s: Supervisor): number {
    let n = 0;
    while (s.hasCapacity() && n < 100) {
      s.start(`sess_${n}`);
      n++;
    }
    return n;
  }

  it("defaults to DEFAULT_MAX_CONCURRENT when unset", () => {
    withEnv(undefined, () => {
      expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
    });
  });

  it("honours a valid override", () => {
    withEnv("3", () => {
      expect(capacityOf(new Supervisor())).toBe(3);
    });
  });

  it.each(["", "abc", "0", "-5"])(
    "falls back to the default for the unusable value %o",
    (raw) => {
      withEnv(raw, () => {
        expect(capacityOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
      });
    },
  );

  it("takes parseInt's truncation of a decimal override", () => {
    withEnv("2.9", () => {
      expect(capacityOf(new Supervisor())).toBe(2);
    });
  });

  it("still lets an explicit constructor argument win over the env var", () => {
    withEnv("3", () => {
      expect(capacityOf(new Supervisor(1))).toBe(1);
    });
  });
});
