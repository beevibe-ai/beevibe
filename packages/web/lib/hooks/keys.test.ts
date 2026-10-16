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

  // The chat keys are the only ones in the table with derivation rather
  // than a literal, and both halves are load-bearing for SSE recovery.
  //
  // `history(undefined)` must collapse to a stable sentinel: `use-chat`
  // writes the "latest conversation" slot through that call
  // (`handLatestSlot`) while the query itself reads `history(cacheId)`.
  // A raw `undefined` tail would still be a usable key, so the sentinel
  // is only observable here.
  it("history(undefined) collapses to the <latest> sentinel slot", () => {
    expect(queryKeys.chat.history(undefined)).toEqual(["chat", "history", "<latest>"]);
    expect(queryKeys.chat.history("conv_1")).toEqual(["chat", "history", "conv_1"]);
  });

  // `lib/sse.ts` invalidates `historyAll` on `session.updated` to refetch
  // EVERY per-conversation slot at once. React Query matches by key
  // prefix, so that fan-out only works while `historyAll` is a strict
  // prefix of whatever `history()` returns — including the sentinel slot.
  it("historyAll is a prefix of every history() slot (so SSE fan-out matches)", () => {
    const prefix = queryKeys.chat.historyAll;
    for (const slot of [
      queryKeys.chat.history(undefined),
      queryKeys.chat.history("conv_1"),
      queryKeys.chat.history("__fresh__"),
    ]) {
      expect(slot.slice(0, prefix.length)).toEqual([...prefix]);
      expect(slot.length).toBeGreaterThan(prefix.length);
    }
  });

  // Sibling namespaces must not collide under that same prefix matching:
  // `chat.conversations` is deliberately NOT swept up by a historyAll
  // invalidation (see the comment on `session.updated` in lib/sse.ts).
  it("chat.conversations sits outside the historyAll prefix", () => {
    const prefix = queryKeys.chat.historyAll;
    const conversations = queryKeys.chat.conversations();
    expect(conversations.slice(0, prefix.length)).not.toEqual([...prefix]);
  });
});
