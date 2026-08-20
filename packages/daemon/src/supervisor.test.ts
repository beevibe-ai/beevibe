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

  it("finish(id) on an unknown session is a no-op (never throws)", () => {
    const s = new Supervisor(1);
    expect(() => s.finish("sess_ghost")).not.toThrow();
    // And it doesn't confuse capacity accounting.
    expect(s.inFlight()).toBe(0);
    expect(s.hasCapacity()).toBe(true);
  });

  it("finishing then restarting the same id frees and re-uses the slot", () => {
    const s = new Supervisor(1);
    s.start("sess_a");
    expect(s.hasCapacity()).toBe(false);
    s.finish("sess_a");
    // The freed slot must actually be usable again.
    expect(() => s.start("sess_a")).not.toThrow();
    expect(s.inFlight()).toBe(1);
  });

  it("cancelAll() on empty is a safe no-op", () => {
    const s = new Supervisor(2);
    expect(() => s.cancelAll()).not.toThrow();
    expect(s.inFlight()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// env-driven default (readMaxFromEnv) — reached only when the constructor
// runs without an explicit `maxConcurrent`.
// ---------------------------------------------------------------------------
describe("Supervisor — BEEVIBE_DAEMON_MAX_CONCURRENT default", () => {
  const originalEnv = process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;

  beforeEach(() => {
    delete process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;
    } else {
      process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = originalEnv;
    }
  });

  it("uses DEFAULT_MAX_CONCURRENT when the env var is absent", () => {
    const s = new Supervisor();
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT; i++) s.start(`sess_${i}`);
    expect(s.hasCapacity()).toBe(false);
    expect(() => s.start("overflow")).toThrow(/at capacity/);
  });

  it("uses DEFAULT_MAX_CONCURRENT on a non-numeric value", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "not-a-number";
    const s = new Supervisor();
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT; i++) s.start(`sess_${i}`);
    expect(s.hasCapacity()).toBe(false);
  });

  it("uses DEFAULT_MAX_CONCURRENT on a value less than 1", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "0";
    const s = new Supervisor();
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT; i++) s.start(`sess_${i}`);
    expect(s.hasCapacity()).toBe(false);
  });

  it("honors a valid positive override from the env", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "2";
    const s = new Supervisor();
    s.start("a");
    s.start("b");
    expect(s.hasCapacity()).toBe(false);
    expect(() => s.start("c")).toThrow(/at capacity/);
  });

  it("truncates a decimal env value on parseInt semantics", () => {
    process.env.BEEVIBE_DAEMON_MAX_CONCURRENT = "3.9";
    const s = new Supervisor();
    s.start("a");
    s.start("b");
    s.start("c");
    expect(s.hasCapacity()).toBe(false);
  });
});
