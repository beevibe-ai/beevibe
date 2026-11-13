/**
 * Runtime domain. `isKnownCli` is the gate between a free-form string
 * off the wire (a daemon's registration payload, an agent's
 * runtime_config.type) and the `KnownCli` union the runtime registry
 * keys off — so a false negative silently drops a working CLI and a
 * false positive reaches a registry lookup that has no entry.
 */
import { describe, expect, it } from "vitest";

import {
  isKnownCli,
  KNOWN_CLIS,
  RUNTIME_HEARTBEAT_INTERVAL_MS,
  type KnownCli,
} from "./runtime.js";

describe("KNOWN_CLIS", () => {
  it("lists the three supported CLIs", () => {
    expect([...KNOWN_CLIS]).toEqual(["claude", "codex", "opencode"]);
  });

  it("has no duplicates", () => {
    expect(new Set(KNOWN_CLIS).size).toBe(KNOWN_CLIS.length);
  });
});

describe("isKnownCli", () => {
  it("accepts every member of KNOWN_CLIS", () => {
    for (const cli of KNOWN_CLIS) {
      expect(isKnownCli(cli)).toBe(true);
    }
  });

  it("rejects an unknown CLI name", () => {
    expect(isKnownCli("cursor")).toBe(false);
  });

  // Case and padding matter: the value is compared against the union
  // members verbatim, and the registry lookup downstream is exact.
  it("is case-sensitive", () => {
    expect(isKnownCli("Claude")).toBe(false);
    expect(isKnownCli("CODEX")).toBe(false);
  });

  it("rejects a padded value", () => {
    expect(isKnownCli(" claude")).toBe(false);
    expect(isKnownCli("claude ")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isKnownCli("")).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["a boolean", true],
    ["an array of a valid name", ["claude"]],
    ["an object", { cli: "claude" }],
  ])("rejects %s", (_label, value) => {
    expect(isKnownCli(value)).toBe(false);
  });

  // Array.prototype.includes is called on the readonly tuple, so a
  // non-own inherited property must not slip through.
  it("rejects an Object.prototype key", () => {
    expect(isKnownCli("toString")).toBe(false);
    expect(isKnownCli("constructor")).toBe(false);
  });

  it("narrows to KnownCli when it returns true", () => {
    const raw: unknown = "codex";
    if (isKnownCli(raw)) {
      // Compile-time assertion: `raw` is KnownCli inside this branch.
      const narrowed: KnownCli = raw;
      expect(narrowed).toBe("codex");
    } else {
      expect.unreachable("isKnownCli should accept 'codex'");
    }
  });
});

describe("RUNTIME_HEARTBEAT_INTERVAL_MS", () => {
  // The DaemonHub derives ONLINE_FRESHNESS_MS = 2x this value, so the
  // constant is a cross-module contract, not a local tuning knob.
  it("is 15s, the cadence the hub's freshness window doubles", () => {
    expect(RUNTIME_HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });
});
