import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("Supervisor concurrency cap from the environment", () => {
  // The cap is read by a default parameter, so it is resolved at
  // construction time — every assertion below builds a fresh Supervisor
  // after setting the env var.
  const ENV = "BEEVIBE_DAEMON_MAX_CONCURRENT";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  function capOf(raw: string | undefined): number {
    if (raw === undefined) delete process.env[ENV];
    else process.env[ENV] = raw;
    const s = new Supervisor();
    // Fill slots until the cap trips; inFlight() then equals the cap.
    for (let i = 0; i < 100 && s.hasCapacity(); i++) s.start(`sess_${i}`);
    return s.inFlight();
  }

  it("defaults to DEFAULT_MAX_CONCURRENT when the var is unset", () => {
    expect(capOf(undefined)).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("honours a valid override", () => {
    expect(capOf("3")).toBe(3);
  });

  it("allows a cap of 1", () => {
    expect(capOf("1")).toBe(1);
  });

  it("falls back on an empty string", () => {
    expect(capOf("")).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("falls back on a non-numeric value", () => {
    expect(capOf("lots")).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("falls back on zero and on negatives rather than deadlocking the daemon", () => {
    expect(capOf("0")).toBe(DEFAULT_MAX_CONCURRENT);
    expect(capOf("-5")).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("truncates a decimal override", () => {
    expect(capOf("2.9")).toBe(2);
  });

  it("an explicit constructor argument wins over the env var", () => {
    process.env[ENV] = "9";
    const s = new Supervisor(1);
    s.start("sess_1");
    expect(s.hasCapacity()).toBe(false);
  });
});
