import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

/** Every derived key in a namespace, paired with the `all` root it must sit under. */
function derivedKeysByNamespace(): Array<[string, readonly unknown[], readonly unknown[]]> {
  const sampleArgs: Record<string, unknown[]> = {
    list: [{}],
    detail: ["id_1"],
    conversation: ["id_1"],
    facts: [{}],
    counts: [],
    activity: [{}],
    overview: [{}],
    summary: [],
    self: [],
    history: ["conv_1"],
    conversations: [],
  };
  const out: Array<[string, readonly unknown[], readonly unknown[]]> = [];
  for (const [ns, group] of Object.entries(queryKeys)) {
    const root = (group as { all: readonly unknown[] }).all;
    for (const [member, value] of Object.entries(group)) {
      if (member === "all") continue;
      const derived =
        typeof value === "function"
          ? (value as (...a: unknown[]) => readonly unknown[])(
              ...(sampleArgs[member] ?? [{}]),
            )
          : (value as readonly unknown[]);
      out.push([`${ns}.${member}`, root, derived]);
    }
  }
  return out;
}

describe("queryKeys", () => {
  // The invariant SSE invalidation rests on: `lib/sse.ts` invalidates a
  // namespace by its `all` root, and react-query matches by prefix. A
  // derived key that doesn't start with its own root is a silent no-op
  // on every event — the failure mode #285 found in `queryKeys.activity`.
  // Table-driven so a namespace added later is covered without an edit.
  it.each(derivedKeysByNamespace())(
    "%s starts with its namespace root (so SSE invalidation cascades reach it)",
    (_name, root, derived) => {
      expect(derived.slice(0, root.length)).toEqual([...root]);
    },
  );

  it("derives list/detail keys that share the root prefix but are distinct from each other", () => {
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
