import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_CONCURRENT, Supervisor } from "./supervisor.js";

const ENV_KEY = "BEEVIBE_DAEMON_MAX_CONCURRENT";

/** Fill the supervisor and report the cap it actually enforced. */
function observedCap(s: Supervisor): number {
  let n = 0;
  while (s.hasCapacity()) {
    s.start(`sess_${n}`);
    n++;
    if (n > 1000) throw new Error("supervisor never reported full");
  }
  return n;
}

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
 * The no-argument constructor reads BEEVIBE_DAEMON_MAX_CONCURRENT — that
 * is the path `runStart` actually takes, and it was the one part of this
 * module with no coverage. A bad parse here either uncaps the daemon or
 * pins it at zero concurrency, and both fail silently at runtime.
 */
describe("Supervisor — cap from BEEVIBE_DAEMON_MAX_CONCURRENT", () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("defaults to DEFAULT_MAX_CONCURRENT when the var is unset", () => {
    delete process.env[ENV_KEY];
    expect(observedCap(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("honors a valid override", () => {
    process.env[ENV_KEY] = "3";
    expect(observedCap(new Supervisor())).toBe(3);
  });

  it("treats an empty string as unset", () => {
    process.env[ENV_KEY] = "";
    expect(observedCap(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("falls back on non-numeric input", () => {
    process.env[ENV_KEY] = "lots";
    expect(observedCap(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  // "0" would wedge the daemon — hasCapacity() false forever, so it
  // claims nothing and no operator error is ever printed.
  it("falls back on values below 1 rather than wedging the claimer", () => {
    process.env[ENV_KEY] = "0";
    expect(observedCap(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
    process.env[ENV_KEY] = "-4";
    expect(observedCap(new Supervisor())).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("takes the integer part of a float override", () => {
    process.env[ENV_KEY] = "2.9";
    expect(observedCap(new Supervisor())).toBe(2);
  });

  // An explicit constructor argument is what the tests above rely on;
  // it must not be overridden by a stray env var in the operator's shell.
  it("lets an explicit constructor argument win over the env var", () => {
    process.env[ENV_KEY] = "7";
    expect(observedCap(new Supervisor(1))).toBe(1);
  });
});
