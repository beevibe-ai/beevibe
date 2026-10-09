/**
 * `isKnownCli` is the gate every runtime binding passes through — the
 * chat route uses it to decide whether a pinned CLI is even
 * representable before reporting a runtime mismatch, so a false
 * positive would surface a bogus `pinned_cli` to the user.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_CLIS, isKnownCli } from "./runtime.js";

describe("isKnownCli", () => {
  it("accepts every member of KNOWN_CLIS", () => {
    for (const cli of KNOWN_CLIS) {
      expect(isKnownCli(cli)).toBe(true);
    }
  });

  it("rejects an unknown CLI name", () => {
    expect(isKnownCli("cursor")).toBe(false);
    expect(isKnownCli("")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(isKnownCli("Claude")).toBe(false);
    expect(isKnownCli("CLAUDE")).toBe(false);
  });

  it("rejects non-string values instead of coercing", () => {
    for (const v of [undefined, null, 0, 1, true, {}, [], ["claude"]]) {
      expect(isKnownCli(v)).toBe(false);
    }
  });

  it("does not inherit Array.prototype members as valid CLIs", () => {
    // Guards the `includes` lookup against prototype-chain surprises.
    expect(isKnownCli("length")).toBe(false);
    expect(isKnownCli("constructor")).toBe(false);
  });
});
