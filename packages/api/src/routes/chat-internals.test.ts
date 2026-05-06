import { describe, expect, it } from "vitest";
import { groupIntoConversations, type ChatSession } from "./chat.js";

function makeSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id">): ChatSession {
  return {
    intent: "test",
    status: "succeeded",
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("groupIntoConversations", () => {
  it("returns empty array for empty input", () => {
    expect(groupIntoConversations([])).toEqual([]);
  });

  it("places a single session in its own chain with itself as head", () => {
    const s = makeSession({ id: "sess_a" });
    const chains = groupIntoConversations([s]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.head_id).toBe("sess_a");
    expect(chains[0]?.sessions.map((x) => x.id)).toEqual(["sess_a"]);
  });

  it("walks prior_session_id pointers to find the chain head", () => {
    const head = makeSession({
      id: "sess_head",
      created_at: new Date("2026-01-01T10:00:00Z"),
    });
    const middle = makeSession({
      id: "sess_mid",
      prior_session_id: "sess_head",
      created_at: new Date("2026-01-01T10:01:00Z"),
    });
    const tail = makeSession({
      id: "sess_tail",
      prior_session_id: "sess_mid",
      created_at: new Date("2026-01-01T10:02:00Z"),
    });
    const chains = groupIntoConversations([tail, middle, head]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.head_id).toBe("sess_head");
    // Sorted oldest-first within the chain.
    expect(chains[0]?.sessions.map((s) => s.id)).toEqual([
      "sess_head",
      "sess_mid",
      "sess_tail",
    ]);
  });

  it("treats orphan sessions (parent outside the input set) as their own chain head", () => {
    // Common case: history pagination cuts the chain mid-way. We
    // surface the fragment instead of dropping it.
    const orphan = makeSession({
      id: "sess_orphan",
      prior_session_id: "sess_outside_window",
    });
    const chains = groupIntoConversations([orphan]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.head_id).toBe("sess_orphan");
  });

  it("does NOT recurse infinitely on a cycle in prior_session_id", () => {
    // Data corruption (bad migration, manual SQL fix) could create a
    // cycle. Pre-fix: stack overflow. Post-fix: bail with one of the
    // cycle members as head.
    const a = makeSession({ id: "sess_a", prior_session_id: "sess_b" });
    const b = makeSession({ id: "sess_b", prior_session_id: "sess_a" });
    const chains = groupIntoConversations([a, b]);
    // The two cycle members collapse into one chain. Head is one of
    // them — the exact one depends on iteration order; both are valid
    // cycle anchors.
    expect(chains).toHaveLength(1);
    expect(["sess_a", "sess_b"]).toContain(chains[0]?.head_id);
    expect(chains[0]?.sessions).toHaveLength(2);
  });

  it("orders chains newest-first by latest activity", () => {
    const oldChain = makeSession({
      id: "sess_old_head",
      created_at: new Date("2026-01-01T00:00:00Z"),
    });
    const newChain = makeSession({
      id: "sess_new_head",
      created_at: new Date("2026-01-02T00:00:00Z"),
    });
    const chains = groupIntoConversations([oldChain, newChain]);
    expect(chains.map((c) => c.head_id)).toEqual(["sess_new_head", "sess_old_head"]);
  });

  it("groups multiple independent chains correctly", () => {
    const a1 = makeSession({ id: "sess_a1" });
    const a2 = makeSession({
      id: "sess_a2",
      prior_session_id: "sess_a1",
      created_at: new Date("2026-01-01T01:00:00Z"),
    });
    const b1 = makeSession({
      id: "sess_b1",
      created_at: new Date("2026-01-01T02:00:00Z"),
    });
    const chains = groupIntoConversations([a1, a2, b1]);
    expect(chains).toHaveLength(2);
    expect(chains.map((c) => c.head_id).sort()).toEqual(["sess_a1", "sess_b1"]);
  });
});
