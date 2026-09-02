import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

describe("queryKeys", () => {
  // `lib/sse.ts` invalidates by a domain's `all` tuple and relies on
  // react-query's prefix matching to reach every slot under it. The literal
  // root strings are private to this table — both producers (the hooks) and
  // the consumer (sse.ts) go through the same constant, so pinning them
  // detects renames without protecting anything. What actually has to hold
  // is the prefix relationship, across every domain rather than a hand-kept
  // subset: `agentNetwork.all` is `["agent-network"]`, so a derived key that
  // drifted to `["agentNetwork", ...]` would silently stop being invalidated.
  it("derives every key under its domain's `all` prefix (so SSE invalidation cascades reach it)", () => {
    const mismatched: string[] = [];
    let checked = 0;

    for (const [domain, group] of Object.entries(queryKeys)) {
      const { all, ...derived } = group as {
        all: readonly unknown[];
      } & Record<string, unknown>;

      for (const [name, member] of Object.entries(derived)) {
        // Every derived member is either a tuple or a builder; the args only
        // land in trailing slots, so a dummy is enough to read the prefix.
        const key =
          typeof member === "function"
            ? (member as (arg?: unknown) => readonly unknown[])({})
            : (member as readonly unknown[]);
        checked += 1;
        if (JSON.stringify(key.slice(0, all.length)) !== JSON.stringify(all)) {
          mismatched.push(
            `${domain}.${name} -> ${JSON.stringify(key)} (expected prefix ${JSON.stringify(all)})`,
          );
        }
      }
    }

    expect(mismatched).toEqual([]);
    // Guard against the walk silently covering nothing if the table's shape changes.
    expect(checked).toBeGreaterThan(20);
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

  it("structural equality across separate calls with the same arg shape", () => {
    const a = queryKeys.tasks.list({ view: "mine" });
    const b = queryKeys.tasks.list({ view: "mine" });
    expect(a).toEqual(b);
  });
});
