/**
 * `isKnownCli` guards the hop from a free-text `runtime.cli` DB column to
 * the `KnownCli` union that selects a runtime adapter. Three call sites
 * (chat.ts, view.ts, runtime/router.ts) rely on it to reject a row
 * written by an older or newer daemon, so a widened check would mean
 * looking up an adapter that doesn't exist.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_CLIS, RUNTIME_HEARTBEAT_INTERVAL_MS, isKnownCli } from "./runtime.js";

describe("isKnownCli", () => {
  it.each([...KNOWN_CLIS])("accepts the known cli %s", (cli) => {
    expect(isKnownCli(cli)).toBe(true);
  });

  it.each([
    ["an unknown cli name", "gemini"],
    ["the wrong case", "Claude"],
    ["a padded name", " claude "],
    ["the empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an object", { cli: "claude" }],
    ["an array of one known cli", ["claude"]],
  ])("rejects %s", (_label, value) => {
    expect(isKnownCli(value)).toBe(false);
  });
});

describe("RUNTIME_HEARTBEAT_INTERVAL_MS", () => {
  it("stays a positive interval the hub's 2x freshness window can derive from", () => {
    // DaemonHub's ONLINE_FRESHNESS_MS is 2x this; a zero or negative
    // cadence would mark every daemon permanently offline.
    expect(RUNTIME_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });
});
