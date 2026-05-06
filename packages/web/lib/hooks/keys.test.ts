import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

describe("queryKeys", () => {
  it("namespaces every domain under a stable root tuple", () => {
    expect(queryKeys.tasks.all).toEqual(["tasks"]);
    expect(queryKeys.agents.all).toEqual(["agents"]);
    expect(queryKeys.sessions.all).toEqual(["sessions"]);
    expect(queryKeys.memory.all).toEqual(["memory"]);
    expect(queryKeys.promotions.all).toEqual(["promotions"]);
    expect(queryKeys.mesh.all).toEqual(["mesh"]);
    expect(queryKeys.dashboard.all).toEqual(["dashboard"]);
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
