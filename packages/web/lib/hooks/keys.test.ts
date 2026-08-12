import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

describe("queryKeys", () => {
  // Load-bearing for lib/sse.ts: it invalidates with the `.all` root
  // (`queryKeys.tasks.all`) and relies on react-query's prefix matching to
  // cascade down to every list/detail slot underneath. A factory that
  // didn't lead with its own root would silently stop refetching on SSE.
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
