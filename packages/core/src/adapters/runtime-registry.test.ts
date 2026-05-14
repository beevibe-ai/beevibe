import { describe, expect, it } from "vitest";
import { createDefaultRuntimeRegistry } from "./runtime-registry.js";

describe("createDefaultRuntimeRegistry", () => {
  it("registers claude-code", () => {
    const registry = createDefaultRuntimeRegistry();
    expect(registry["claude"]).toBeDefined();
    expect(registry["claude"]!.type).toBe("claude");
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
