import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

// Discover the domains rather than listing them, so a domain added to
// keys.ts is covered here without anyone remembering to update this file.
// (The previous version hard-coded 7 of the 16 root tuples as literals
// copied from the source, so it grew stale silently and could only fail
// if someone edited both files.)
const roots = Object.entries(queryKeys).map(
  ([domain, keys]) => [domain, (keys as { all: readonly string[] }).all] as const,
);

describe("queryKeys", () => {
  it("gives every domain a distinct single-segment root tuple", () => {
    // lib/sse.ts invalidates by root: invalidateQueries({ queryKey:
    // <domain>.all }), which matches by *prefix*. A root that is
    // multi-segment or shared with another domain would make one SSE
    // event blow away an unrelated domain's cache, so the roots have to
    // be 1-tuples and pairwise unique.
    expect(roots.length).toBeGreaterThan(0);
    for (const [domain, all] of roots) {
      expect(all, `${domain}.all should be a 1-tuple`).toHaveLength(1);
      expect(typeof all[0], `${domain}.all[0] should be a string`).toBe("string");
      expect(all[0], `${domain}.all[0] should be non-empty`).not.toBe("");
    }
    const segments = roots.map(([, all]) => all[0]);
    expect(new Set(segments).size, `duplicate root segment in ${segments.join(", ")}`).toBe(
      segments.length,
    );
  });

  it("derives list/detail keys that share the root prefix (so SSE invalidation cascades work)", () => {
    const taskList = queryKeys.tasks.list({ view: "mine" });
    const taskDetail = queryKeys.tasks.detail("t_1");
    expect(taskList[0]).toBe("tasks");
    expect(taskDetail[0]).toBe("tasks");
    expect(taskList).not.toEqual(taskDetail);
  });

  it("filter args are part of the key (so different filters cache separately)", () => {
    const a = queryKeys.tasks.list({ view: "all" });
    const b = queryKeys.tasks.list({ view: "mine" });
    expect(a).not.toEqual(b);
  });
});
