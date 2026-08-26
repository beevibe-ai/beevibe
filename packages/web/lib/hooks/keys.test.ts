import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

// Every call site invalidates through `queryKeys.<domain>.all` rather than
// a bare string, so the root's literal spelling is arbitrary. What the app
// does depend on is that each domain's derived keys start with that
// domain's own root — that prefix is what makes
// `invalidateQueries({ queryKey: queryKeys.tasks.all })` cascade to the
// list and detail slots.
describe("queryKeys", () => {
  it("prefixes every derived key with its own domain root (so invalidation cascades)", () => {
    for (const [domain, group] of Object.entries(queryKeys)) {
      const { all, ...derived } = group as Record<string, unknown> & {
        all: readonly string[];
      };
      for (const [name, value] of Object.entries(derived)) {
        // `historyAll` is a bare prefix tuple; everything else is a builder.
        const key = typeof value === "function" ? value({}) : value;
        expect(
          (key as readonly string[]).slice(0, all.length),
          `${domain}.${name} must start with ${JSON.stringify(all)}`,
        ).toEqual([...all]);
      }
    }
  });

  it("separates list from detail within a domain", () => {
    expect(queryKeys.tasks.list({ view: "mine" })).not.toEqual(
      queryKeys.tasks.detail("t_1"),
    );
  });

  it("filter args are part of the key (so different filters cache separately)", () => {
    const a = queryKeys.tasks.list({ view: "all" });
    const b = queryKeys.tasks.list({ view: "mine" });
    expect(a).not.toEqual(b);
  });
});
