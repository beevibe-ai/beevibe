import { describe, expect, it } from "vitest";
import {
  createDefaultRuntimeRegistry,
  parseRuntimeMissingError,
  runtimeMissingError,
} from "./runtime-registry.js";

describe("createDefaultRuntimeRegistry", () => {
  // Exact set, not a superset: `runtime_config.type` is persisted per agent,
  // so a key that silently disappears strands every row pointing at it, and
  // a key that silently appears is a runtime nothing validated.
  it("registers exactly claude, codex and opencode", () => {
    const registry = createDefaultRuntimeRegistry();
    expect(Object.keys(registry).sort()).toEqual(["claude", "codex", "opencode"]);
  });

  it("every registry value's .type matches its registry key (sanity check against typos)", () => {
    const registry = createDefaultRuntimeRegistry();
    for (const [key, runtime] of Object.entries(registry)) {
      expect(runtime.type).toBe(key);
    }
  });

  it("returns a fresh registry on each call (no shared mutable state across composition roots)", () => {
    const a = createDefaultRuntimeRegistry();
    const b = createDefaultRuntimeRegistry();
    // Different object identity — consumers can mutate one without affecting the other.
    expect(a).not.toBe(b);
  });
});

describe("runtimeMissingError / parseRuntimeMissingError", () => {
  it("round-trips a CLI name through the producer/consumer pair", () => {
    // The daemon's spawner produces this string when it gets a dispatch
    // payload for a CLI it doesn't have registered; the api's chat route
    // parses it to swap for a user-actionable message. The two must stay
    // byte-for-byte in sync — this test is the enforcement.
    for (const cli of ["claude", "codex", "opencode", "future-cli"]) {
      const produced = runtimeMissingError(cli);
      expect(parseRuntimeMissingError(produced)).toBe(cli);
    }
  });

  it("returns undefined for strings that don't match the pattern", () => {
    expect(parseRuntimeMissingError("ENOMEM")).toBeUndefined();
    expect(parseRuntimeMissingError("CLI exited with code 1")).toBeUndefined();
    expect(parseRuntimeMissingError("")).toBeUndefined();
    // Substring-only matches don't count — the pattern is anchored.
    expect(
      parseRuntimeMissingError(
        "PREFIX No runtime registered for dispatch payload type 'claude' SUFFIX",
      ),
    ).toBeUndefined();
  });
});
