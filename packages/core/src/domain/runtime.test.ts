import { describe, expect, it } from "vitest";
import {
  KNOWN_CLIS,
  RUNTIME_HEARTBEAT_INTERVAL_MS,
  isKnownCli,
} from "./runtime.js";

describe("isKnownCli", () => {
  it("accepts every entry in KNOWN_CLIS", () => {
    for (const cli of KNOWN_CLIS) {
      expect(isKnownCli(cli)).toBe(true);
    }
  });

  it("rejects unknown strings, including case variants", () => {
    expect(isKnownCli("cursor")).toBe(false);
    expect(isKnownCli("Claude")).toBe(false);
    expect(isKnownCli("")).toBe(false);
  });

  it("rejects non-string values rather than throwing", () => {
    for (const v of [undefined, null, 0, 1, true, {}, [], ["claude"]]) {
      expect(isKnownCli(v)).toBe(false);
    }
  });
});

describe("RUNTIME_HEARTBEAT_INTERVAL_MS", () => {
  // DaemonHub derives ONLINE_FRESHNESS_MS = 2x this value, and the
  // daemon's claimer uses it as its default cadence. A silent change
  // here desyncs the hub's "one missed beat is OK" tolerance.
  it("is pinned at 15s", () => {
    expect(RUNTIME_HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });
});
