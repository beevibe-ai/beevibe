import { describe, expect, it } from "vitest";
import { KNOWN_CLIS, RUNTIME_HEARTBEAT_INTERVAL_MS, isKnownCli } from "./runtime.js";

describe("isKnownCli", () => {
  it.each([...KNOWN_CLIS])("accepts the known cli %s", (cli) => {
    expect(isKnownCli(cli)).toBe(true);
  });

  it.each([
    ["an unknown cli name", "cursor"],
    ["a case variant", "Claude"],
    ["an empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an object", { cli: "claude" }],
    ["an array containing a known cli", ["claude"]],
  ])("rejects %s", (_label, value) => {
    expect(isKnownCli(value)).toBe(false);
  });
});

describe("runtime constants", () => {
  it("lists exactly the three supported CLIs", () => {
    expect([...KNOWN_CLIS]).toEqual(["claude", "codex", "opencode"]);
  });

  it("keeps the heartbeat cadence at 15s — DaemonHub's freshness window is 2x this", () => {
    expect(RUNTIME_HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });
});
