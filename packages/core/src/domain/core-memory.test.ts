import { describe, expect, it } from "vitest";
import { HIERARCHY_LEVELS } from "./agent.js";
import {
  DEFAULT_BLOCK_TEMPLATES,
  ROUTING_BLOCKS,
  TOTAL_BLOCK_CHAR_LIMIT,
} from "./core-memory.js";

/**
 * `DEFAULT_BLOCK_TEMPLATES` is the source of truth for block descriptions:
 * `coreMemoryRepo.initDefaults` seeds new agents from it, `pnpm
 * sync-core-memory` back-fills existing ones, and the MCP tool definitions
 * echo the same descriptions to the agent. Drift here is silent — nothing
 * type-checks a block name against the templates — so these are consistency
 * assertions, not restatements of the data.
 */
describe("DEFAULT_BLOCK_TEMPLATES", () => {
  it("covers every hierarchy level", () => {
    for (const level of HIERARCHY_LEVELS) {
      expect(DEFAULT_BLOCK_TEMPLATES[level].length).toBeGreaterThan(0);
    }
    expect(Object.keys(DEFAULT_BLOCK_TEMPLATES).sort()).toEqual(
      [...HIERARCHY_LEVELS].sort(),
    );
  });

  it("has unique block names within each level", () => {
    for (const level of HIERARCHY_LEVELS) {
      const names = DEFAULT_BLOCK_TEMPLATES[level].map((t) => t.block_name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("gives every block a positive char_limit and a non-empty description", () => {
    for (const level of HIERARCHY_LEVELS) {
      for (const t of DEFAULT_BLOCK_TEMPLATES[level]) {
        expect(t.block_name).not.toBe("");
        expect(t.char_limit).toBeGreaterThan(0);
        expect(t.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("seeds initial_content that fits inside the block's own char_limit", () => {
    // initDefaults writes initial_content straight through; a template that
    // over-fills its own limit would break agent creation on the first write.
    for (const level of HIERARCHY_LEVELS) {
      for (const t of DEFAULT_BLOCK_TEMPLATES[level]) {
        expect(t.initial_content.length).toBeLessThanOrEqual(t.char_limit);
      }
    }
  });

  it("keeps each level's total char budget under TOTAL_BLOCK_CHAR_LIMIT", () => {
    for (const level of HIERARCHY_LEVELS) {
      const total = DEFAULT_BLOCK_TEMPLATES[level].reduce(
        (sum, t) => sum + t.char_limit,
        0,
      );
      expect(total).toBeLessThanOrEqual(TOTAL_BLOCK_CHAR_LIMIT);
    }
  });

  it("gives every level a tag_line and a persona block", () => {
    // The agent cards in the web UI read tag_line; every briefing reads persona.
    for (const level of HIERARCHY_LEVELS) {
      const names = DEFAULT_BLOCK_TEMPLATES[level].map((t) => t.block_name);
      expect(names).toContain("tag_line");
      expect(names).toContain("persona");
    }
  });

  it("caps tag_line at 100 chars on every level (the UI card width)", () => {
    for (const level of HIERARCHY_LEVELS) {
      const tagLine = DEFAULT_BLOCK_TEMPLATES[level].find(
        (t) => t.block_name === "tag_line",
      );
      expect(tagLine?.char_limit).toBe(100);
    }
  });

  it("marks every default block is_system", () => {
    for (const level of HIERARCHY_LEVELS) {
      for (const t of DEFAULT_BLOCK_TEMPLATES[level]) {
        expect(t.is_system).toBe(true);
      }
    }
  });
});

describe("ROUTING_BLOCKS", () => {
  it("covers every hierarchy level", () => {
    expect(Object.keys(ROUTING_BLOCKS).sort()).toEqual(
      [...HIERARCHY_LEVELS].sort(),
    );
  });

  it("only names blocks that the same level actually seeds", () => {
    // Routing reads these by name; a typo or a renamed template would make
    // the routing prompt silently consult nothing.
    for (const level of HIERARCHY_LEVELS) {
      const seeded = new Set(
        DEFAULT_BLOCK_TEMPLATES[level].map((t) => t.block_name),
      );
      for (const name of ROUTING_BLOCKS[level]) {
        expect(seeded.has(name)).toBe(true);
      }
    }
  });

  it("consults persona on every level and lists no duplicates", () => {
    for (const level of HIERARCHY_LEVELS) {
      const blocks = ROUTING_BLOCKS[level];
      expect(blocks).toContain("persona");
      expect(new Set(blocks).size).toBe(blocks.length);
    }
  });
});
