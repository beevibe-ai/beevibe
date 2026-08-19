import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_CONCURRENT, Supervisor } from "./supervisor.js";

const ENV = "BEEVIBE_DAEMON_MAX_CONCURRENT";

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

describe("Supervisor default cap from the environment", () => {
  let previous: string | undefined;

  /** Fill the supervisor and report the cap it actually enforced. */
  function effectiveCap(): number {
    const s = new Supervisor();
    let n = 0;
    while (s.hasCapacity()) {
      s.start(`sess_${n}`);
      n += 1;
      if (n > DEFAULT_MAX_CONCURRENT * 2) throw new Error("cap never reached");
    }
    return n;
  }

  beforeEach(() => {
    previous = process.env[ENV];
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  });

  it("defaults to DEFAULT_MAX_CONCURRENT when the env var is unset", () => {
    delete process.env[ENV];

    expect(effectiveCap()).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("honors a valid override", () => {
    process.env[ENV] = "3";

    expect(effectiveCap()).toBe(3);
  });

  it("parses a trailing-garbage value down to its leading integer", () => {
    process.env[ENV] = "4 workers";

    expect(effectiveCap()).toBe(4);
  });

  it.each(["", "many", "0", "-2", "NaN"])(
    "falls back to the default for the unusable value %j",
    (raw) => {
      process.env[ENV] = raw;

      expect(effectiveCap()).toBe(DEFAULT_MAX_CONCURRENT);
    },
  );
});
