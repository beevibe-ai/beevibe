import { describe, expect, it } from "vitest";
import type { HierarchyLevel } from "../../domain/agent.js";
import {
  TEAM_ONLY_SKILLS,
  UNIVERSAL_SKILLS,
  tierFilterFor,
} from "./tier-filter.js";

describe("tierFilterFor", () => {
  it("gives an ic only the universal skills", () => {
    expect([...tierFilterFor("ic")].sort()).toEqual([...UNIVERSAL_SKILLS].sort());
  });

  it.each(["team", "org"] as HierarchyLevel[])(
    "gives a %s tier the universal skills plus the team-only ones",
    (level) => {
      const set = tierFilterFor(level);
      for (const s of UNIVERSAL_SKILLS) expect(set.has(s)).toBe(true);
      for (const s of TEAM_ONLY_SKILLS) expect(set.has(s)).toBe(true);
      expect(set.size).toBe(UNIVERSAL_SKILLS.length + TEAM_ONLY_SKILLS.length);
    },
  );

  it("withholds team-only skills from an ic", () => {
    const set = tierFilterFor("ic");
    for (const s of TEAM_ONLY_SKILLS) expect(set.has(s)).toBe(false);
  });

  it("returns a fresh Set each call, so a caller mutating it can't poison the next agent", () => {
    const first = tierFilterFor("ic");
    const size = first.size;
    first.add("beevibe-injected");
    first.delete([...UNIVERSAL_SKILLS][0]);

    const second = tierFilterFor("ic");
    expect(second.size).toBe(size);
    expect(second.has("beevibe-injected")).toBe(false);
    expect(second.has([...UNIVERSAL_SKILLS][0])).toBe(true);
  });

  it("names team-only skills with the beevibe-team- prefix so universal skills sort first", () => {
    // The prefix ordering keeps the cross-tier head of Claude Code's
    // auto-discovered skill block byte-identical, which is what makes it
    // prompt-cacheable.
    for (const s of TEAM_ONLY_SKILLS) expect(s.startsWith("beevibe-team-")).toBe(true);
    for (const s of UNIVERSAL_SKILLS) expect(s.startsWith("beevibe-team-")).toBe(false);
  });
});
