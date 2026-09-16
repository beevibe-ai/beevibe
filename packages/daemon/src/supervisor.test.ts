import { afterEach, describe, expect, it, vi } from "vitest";
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
 * `runStart` builds the Supervisor with no argument, so the env-derived
 * default is the only cap production ever uses — a bad parse silently
 * un-bounding (or zero-bounding) concurrent CLI spawns is the failure
 * mode these guard.
 */
describe("Supervisor — cap from BEEVIBE_DAEMON_MAX_CONCURRENT", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function capOf(supervisor: Supervisor): number {
    let n = 0;
    while (supervisor.hasCapacity()) {
      supervisor.start(`sess_${n++}`);
    }
    return n;
  }

  it("defaults to 10 when the env var is unset", () => {
    vi.stubEnv("BEEVIBE_DAEMON_MAX_CONCURRENT", undefined);

    expect(capOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
    expect(DEFAULT_MAX_CONCURRENT).toBe(10);
  });

  it("uses the env var when it parses to a positive integer", () => {
    vi.stubEnv("BEEVIBE_DAEMON_MAX_CONCURRENT", "3");

    expect(capOf(new Supervisor())).toBe(3);
  });

  it.each(["", "not-a-number", "0", "-1"])(
    "falls back to the default for %j rather than un-bounding spawns",
    (raw) => {
      vi.stubEnv("BEEVIBE_DAEMON_MAX_CONCURRENT", raw);

      expect(capOf(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
    },
  );

  it("takes an explicit constructor cap over the env var", () => {
    vi.stubEnv("BEEVIBE_DAEMON_MAX_CONCURRENT", "9");

    expect(capOf(new Supervisor(2))).toBe(2);
  });
});
