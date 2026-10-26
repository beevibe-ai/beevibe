import { describe, expect, it } from "vitest";
import { KNOWN_CLIS, isKnownCli } from "./runtime.js";

/**
 * `isKnownCli` guards the boundary where a free-text `runtime.cli` column
 * becomes a typed `KnownCli`. Its callers (chat.ts, view.ts, the runtime
 * router) hand it whatever the DB holds, including undefined when no
 * runtime is bound — so the non-string cases are the real contract.
 */
describe("isKnownCli", () => {
  it("accepts every CLI in KNOWN_CLIS", () => {
    for (const cli of KNOWN_CLIS) {
      expect(isKnownCli(cli), cli).toBe(true);
    }
  });

  it("rejects an unknown CLI name", () => {
    expect(isKnownCli("cursor")).toBe(false);
    expect(isKnownCli("")).toBe(false);
  });

  it("is case- and whitespace-sensitive — the column stores the exact alias", () => {
    expect(isKnownCli("Claude")).toBe(false);
    expect(isKnownCli("claude ")).toBe(false);
  });

  // The router reaches it as `isKnownCli(claimedRuntime?.cli)`, so an
  // unbound runtime arrives as undefined rather than a string.
  it("rejects non-string values", () => {
    for (const value of [undefined, null, 7, true, {}, ["claude"]]) {
      expect(isKnownCli(value), String(value)).toBe(false);
    }
  });

  // includes() on a boxed String would pass a naive implementation.
  it("rejects a String object wrapping a known CLI", () => {
    expect(isKnownCli(new String("claude"))).toBe(false);
  });
});
