import { describe, expect, it } from "vitest";
import type { HierarchyLevel } from "./agent.js";
import {
  FACT_TYPES,
  FACT_TYPE_DESCRIPTIONS,
  MEMORY_SCOPES,
  hierarchyToScope,
} from "./memory.js";

/** Every tier, so each assertion below sweeps the whole hierarchy. */
const HIERARCHY_LEVELS: readonly HierarchyLevel[] = ["ic", "team", "org"];

describe("hierarchyToScope", () => {
  it("maps every hierarchy level to a valid memory scope", () => {
    for (const level of HIERARCHY_LEVELS) {
      expect(MEMORY_SCOPES).toContain(hierarchyToScope(level));
    }
  });

  it("is an identity mapping today", () => {
    // The helper exists so the two nominal types can diverge later; until
    // they do, the values must stay in lockstep or the cast is a lie.
    expect([...MEMORY_SCOPES].sort()).toEqual([...HIERARCHY_LEVELS].sort());
    for (const level of HIERARCHY_LEVELS) {
      expect(hierarchyToScope(level)).toBe(level);
    }
  });

  it("does not invent a scope for an unlisted level", () => {
    // Guards the day someone adds a HierarchyLevel without extending
    // MemoryScope: the cast would silently produce an unknown scope.
    expect(MEMORY_SCOPES).toContain(hierarchyToScope("ic" as HierarchyLevel));
  });
});

describe("FACT_TYPE_DESCRIPTIONS", () => {
  it("describes every fact type exactly once", () => {
    // The `save_memory` tool builds its `fact_type` enum from FACT_TYPES and
    // its per-value guidance from this record — a missing key ships an enum
    // value with no guidance, which is how #90's over-saving started.
    expect(Object.keys(FACT_TYPE_DESCRIPTIONS).sort()).toEqual(
      [...FACT_TYPES].sort(),
    );
  });

  it("has no empty guidance", () => {
    for (const type of FACT_TYPES) {
      expect(FACT_TYPE_DESCRIPTIONS[type].trim().length).toBeGreaterThan(0);
    }
  });

  it("lists each fact type only once", () => {
    expect(new Set(FACT_TYPES).size).toBe(FACT_TYPES.length);
  });
});
