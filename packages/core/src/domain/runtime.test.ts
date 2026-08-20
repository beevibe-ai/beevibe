import { describe, expect, it } from "vitest";
import {
  isKnownCli,
  KNOWN_CLIS,
  RUNTIME_HEARTBEAT_INTERVAL_MS,
} from "./runtime.js";

describe("isKnownCli", () => {
  it("accepts every entry in KNOWN_CLIS", () => {
    for (const cli of KNOWN_CLIS) {
      expect(isKnownCli(cli)).toBe(true);
    }
  });

  it("rejects unknown CLI strings", () => {
    expect(isKnownCli("copilot")).toBe(false);
    expect(isKnownCli("Claude")).toBe(false); // case-sensitive
    expect(isKnownCli("")).toBe(false);
  });

  it("rejects non-string inputs (guards against JSON payloads)", () => {
    expect(isKnownCli(undefined)).toBe(false);
    expect(isKnownCli(null)).toBe(false);
    expect(isKnownCli(1)).toBe(false);
    expect(isKnownCli({ cli: "claude" })).toBe(false);
    expect(isKnownCli(["claude"])).toBe(false);
  });
});

describe("KNOWN_CLIS", () => {
  it("has no duplicates", () => {
    expect(new Set(KNOWN_CLIS).size).toBe(KNOWN_CLIS.length);
  });

  it("keeps claude/codex/opencode as the three supported CLIs", () => {
    // Pinning this list stops silent additions to the runtime-registry
    // union from slipping in without a routing update.
    expect(new Set(KNOWN_CLIS)).toEqual(
      new Set(["claude", "codex", "opencode"]),
    );
  });
});

describe("RUNTIME_HEARTBEAT_INTERVAL_MS", () => {
  it("is 15s — hub's 2× freshness window derives from this", () => {
    // If this changes, the DaemonHub's ONLINE_FRESHNESS_MS (= 2× this)
    // has to change with it. Pin so a silent shift trips the test.
    expect(RUNTIME_HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });
});
