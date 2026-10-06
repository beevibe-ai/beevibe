/**
 * useChatStream / useChatStreamTree tests.
 *
 * These two hooks are what turns the raw SSE bus into the chat
 * surface's live working trace, and every filter in them exists
 * because of a concrete bug: steps leaking across turns, spawn events
 * from unrelated sessions landing in the tree, duplicate event ids
 * double-rendering a tool call. The `./sse` module is mocked down to a
 * listener capture so each case can feed exact event sequences; the
 * real `useSseEvents` is covered by lib/sse.test.tsx.
 */
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { BvEvent } from "./sse";
import type { SessionTreeNode } from "./types/sessions";

// Listener capture in place of the shared EventSource connection.
const listeners = new Set<(ev: BvEvent) => void>();
vi.mock("@/lib/sse", () => ({
  useSseEvents: (cb: (ev: BvEvent) => void) => {
    // Mirrors the real hook: subscribe for the life of the callback.
    useEffect(() => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }, [cb]);
  },
}));

const treeFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  api: { sessions: { tree: (...args: unknown[]) => treeFetch(...args) } },
}));

import { useChatStream, useChatStreamTree } from "./chat-stream";

function emit(ev: BvEvent) {
  act(() => {
    for (const l of [...listeners]) l(ev);
  });
}

function stepEvent(
  sessionId: string,
  data: Record<string, unknown>,
): BvEvent {
  return { event: "session.step", id: sessionId, data };
}

function node(over: Partial<SessionTreeNode> & { id: string }): SessionTreeNode {
  return {
    short_id: over.id.slice(5, 11),
    parent_session_id: null,
    agent_id: "agent_root",
    agent_label: "Root",
    agent_hierarchy: "team",
    task_id: null,
    task_short_id: null,
    task_title: null,
    type: "chat",
    status: "running",
    intent: "",
    started_at: null,
    completed_at: null,
    ...over,
  };
}

beforeEach(() => {
  listeners.clear();
  treeFetch.mockReset();
  treeFetch.mockResolvedValue({ root: node({ id: "sess_rootaaa" }), descendants: [] });
});

describe("useChatStream", () => {
  it("accumulates steps for the subscribed session in arrival order", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit(stepEvent("sess_a", { kind: "tool_call", event_id: "e1", tool_name: "Read", content: "a.ts" }));
    emit(stepEvent("sess_a", { kind: "tool_result", event_id: "e2", content: "ok" }));

    expect(result.current.steps.map((s) => s.event_id)).toEqual(["e1", "e2"]);
    expect(result.current.steps[0]).toMatchObject({
      kind: "tool_call",
      tool_name: "Read",
      content: "a.ts",
    });
    expect(typeof result.current.steps[0]?.received_at).toBe("number");
  });

  it("ignores steps addressed to another session", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit(stepEvent("sess_other", { kind: "agent", event_id: "e1", content: "hi" }));

    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("ignores every event while no session is subscribed", () => {
    const { result } = renderHook(() => useChatStream(undefined));

    emit(stepEvent("sess_a", { kind: "agent", event_id: "e1", content: "hi" }));

    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("dedupes a replayed event id", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    const ev = stepEvent("sess_a", { kind: "agent", event_id: "e1", content: "hi" });

    emit(ev);
    emit(ev);

    expect(result.current.steps).toHaveLength(1);
  });

  it.each(["tool_call", "tool_result", "agent", "summary"])(
    "accepts kind=%s",
    (kind) => {
      const { result } = renderHook(() => useChatStream("sess_a"));
      emit(stepEvent("sess_a", { kind, event_id: `e-${kind}`, content: "x" }));
      expect(result.current.steps).toHaveLength(1);
    },
  );

  it.each([
    ["an unknown kind", { kind: "heartbeat", event_id: "e1" }],
    ["a missing kind", { event_id: "e1" }],
    ["a non-string kind", { kind: 3, event_id: "e1" }],
  ])("drops a step with %s", (_label, data) => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a", data as Record<string, unknown>));
    expect(result.current.steps).toEqual([]);
  });

  it("drops a session.step event with no data payload", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit({ event: "session.step", id: "sess_a" });
    expect(result.current.steps).toEqual([]);
  });

  it("drops a non-step event on the subscribed session", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit({ event: "session.updated", id: "sess_a", data: { kind: "agent" } });
    expect(result.current.steps).toEqual([]);
  });

  it("synthesizes an event_id when the payload omits one, and coerces missing content to ''", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit(stepEvent("sess_a", { kind: "agent" }));

    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]?.event_id).toMatch(/^sess_a-\d+$/);
    expect(result.current.steps[0]?.content).toBe("");
    expect(result.current.steps[0]?.tool_name).toBeUndefined();
  });

  it("drops a non-string tool_name rather than rendering it", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a", { kind: "tool_call", event_id: "e1", tool_name: 9, content: "" }));
    expect(result.current.steps[0]?.tool_name).toBeUndefined();
  });

  it("keeps a completed turn's steps in stepsBySession when the session id advances", () => {
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useChatStream(sid),
      { initialProps: { sid: "sess_turn1" } },
    );

    emit(stepEvent("sess_turn1", { kind: "agent", event_id: "t1", content: "first" }));
    rerender({ sid: "sess_turn2" });

    // Fresh array for the new turn...
    expect(result.current.steps).toEqual([]);
    // ...but the finished turn is still looked up by its session id.
    expect(result.current.stepsBySession.sess_turn1?.map((s) => s.event_id)).toEqual(["t1"]);

    emit(stepEvent("sess_turn2", { kind: "agent", event_id: "t2", content: "second" }));

    expect(result.current.steps.map((s) => s.event_id)).toEqual(["t2"]);
    expect(Object.keys(result.current.stepsBySession).sort()).toEqual([
      "sess_turn1",
      "sess_turn2",
    ]);
  });

  it("returns the same empty array identity for a session with no steps", () => {
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | undefined }) => useChatStream(sid),
      { initialProps: { sid: "sess_a" as string | undefined } },
    );
    const first = result.current.steps;
    rerender({ sid: undefined });
    expect(result.current.steps).toBe(first);
  });
});

describe("useChatStreamTree hydration", () => {
  it("hydrates root + descendants from /tree and derives the adjacency map", async () => {
    treeFetch.mockResolvedValue({
      root: node({ id: "sess_rootaaa" }),
      descendants: [
        node({ id: "sess_kidaaaa", parent_session_id: "sess_rootaaa", type: "task" }),
        node({ id: "sess_kidbbbb", parent_session_id: "sess_rootaaa", type: "task" }),
        node({ id: "sess_grandaa", parent_session_id: "sess_kidaaaa", type: "task" }),
      ],
    });

    const { result } = renderHook(() => useChatStreamTree("sess_rootaaa"));

    await waitFor(() => expect(Object.keys(result.current.nodes)).toHaveLength(4));
    expect(treeFetch).toHaveBeenCalledWith("sess_rootaaa");
    expect(result.current.children).toEqual({
      sess_rootaaa: ["sess_kidaaaa", "sess_kidbbbb"],
      sess_kidaaaa: ["sess_grandaa"],
    });
    expect(result.current.steps).toEqual({});
  });

  it("stays empty and skips the fetch with no root session", () => {
    const { result } = renderHook(() => useChatStreamTree(undefined));

    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
    expect(treeFetch).not.toHaveBeenCalled();
  });

  it("resets to empty when the root goes away", async () => {
    const { result, rerender } = renderHook(
      ({ root }: { root: string | undefined }) => useChatStreamTree(root),
      { initialProps: { root: "sess_rootaaa" as string | undefined } },
    );
    await waitFor(() => expect(result.current.nodes.sess_rootaaa).toBeDefined());

    rerender({ root: undefined });

    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });

  it("survives a failed /tree fetch — SSE still populates the tree", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    treeFetch.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useChatStreamTree("sess_rootaaa"));

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current.nodes).toEqual({});
    warn.mockRestore();
  });

  it("refetches when the root changes", async () => {
    const { rerender } = renderHook(
      ({ root }: { root: string }) => useChatStreamTree(root),
      { initialProps: { root: "sess_rootaaa" } },
    );
    await waitFor(() => expect(treeFetch).toHaveBeenCalledTimes(1));

    treeFetch.mockResolvedValue({ root: node({ id: "sess_rootbbb" }), descendants: [] });
    rerender({ root: "sess_rootbbb" });

    await waitFor(() => expect(treeFetch).toHaveBeenCalledTimes(2));
    expect(treeFetch).toHaveBeenLastCalledWith("sess_rootbbb");
  });

  it("ignores a /tree response that resolves after the root changed away", async () => {
    let resolveFirst: ((v: unknown) => void) | undefined;
    treeFetch.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    treeFetch.mockResolvedValue({ root: node({ id: "sess_rootbbb" }), descendants: [] });

    const { result, rerender } = renderHook(
      ({ root }: { root: string }) => useChatStreamTree(root),
      { initialProps: { root: "sess_rootaaa" } },
    );
    rerender({ root: "sess_rootbbb" });
    await waitFor(() => expect(result.current.nodes.sess_rootbbb).toBeDefined());

    await act(async () => {
      resolveFirst?.({ root: node({ id: "sess_rootaaa" }), descendants: [] });
    });

    expect(result.current.nodes.sess_rootaaa).toBeUndefined();
  });
});

describe("useChatStreamTree live events", () => {
  async function mounted(rootId = "sess_rootaaa") {
    const hook = renderHook(() => useChatStreamTree(rootId));
    await waitFor(() => expect(hook.result.current.nodes[rootId]).toBeDefined());
    return hook;
  }

  function spawnEvent(parentId: string, data: Record<string, unknown>): BvEvent {
    return { event: "session.spawned", id: parentId, data };
  }

  it("attaches a spawned child to a known parent, deriving its short ids", async () => {
    const { result } = await mounted();

    emit(
      spawnEvent("sess_rootaaa", {
        child_session_id: "sess_childxyz",
        agent_id: "agent_ic",
        task_id: "task_abcdefgh",
        intent: "fix the thing",
      }),
    );

    const child = result.current.nodes.sess_childxyz;
    expect(child).toMatchObject({
      id: "sess_childxyz",
      short_id: "childx",
      parent_session_id: "sess_rootaaa",
      agent_id: "agent_ic",
      // The spawn payload carries no label/hierarchy; placeholders stand in
      // until the /tree refetch replaces them.
      agent_label: "agent_ic",
      agent_hierarchy: "ic",
      task_id: "task_abcdefgh",
      task_short_id: "abcdef",
      type: "task",
      status: "pending",
      intent: "fix the thing",
    });
    expect(result.current.children.sess_rootaaa).toEqual(["sess_childxyz"]);
  });

  it("falls back to the full id as short_id for an unexpectedly short child id", async () => {
    const { result } = await mounted();

    emit(spawnEvent("sess_rootaaa", { child_session_id: "sess_x", agent_id: "agent_ic" }));

    expect(result.current.nodes.sess_x).toMatchObject({
      short_id: "sess_x",
      task_id: null,
      task_short_id: null,
      intent: "",
    });
  });

  it("leaves task_short_id null for a too-short task id", async () => {
    const { result } = await mounted();

    emit(
      spawnEvent("sess_rootaaa", {
        child_session_id: "sess_childxyz",
        agent_id: "agent_ic",
        task_id: "task_1",
      }),
    );

    expect(result.current.nodes.sess_childxyz).toMatchObject({
      task_id: "task_1",
      task_short_id: null,
    });
  });

  it("drops a spawn whose parent is not in this tree (shared SSE bus)", async () => {
    const { result } = await mounted();

    emit(
      spawnEvent("sess_elsewher", { child_session_id: "sess_childxyz", agent_id: "agent_ic" }),
    );

    expect(result.current.nodes.sess_childxyz).toBeUndefined();
  });

  it("dedupes a replayed spawn event", async () => {
    const { result } = await mounted();
    const ev = spawnEvent("sess_rootaaa", {
      child_session_id: "sess_childxyz",
      agent_id: "agent_ic",
    });

    emit(ev);
    const afterFirst = result.current.nodes.sess_childxyz;
    emit(ev);

    expect(result.current.nodes.sess_childxyz).toBe(afterFirst);
    expect(result.current.children.sess_rootaaa).toEqual(["sess_childxyz"]);
  });

  it.each([
    ["no child_session_id", { agent_id: "agent_ic" }],
    ["no agent_id", { child_session_id: "sess_childxyz" }],
    ["non-string ids", { child_session_id: 1, agent_id: 2 }],
  ])("drops a malformed spawn payload: %s", async (_label, data) => {
    const { result } = await mounted();

    emit(spawnEvent("sess_rootaaa", data as Record<string, unknown>));

    expect(Object.keys(result.current.nodes)).toEqual(["sess_rootaaa"]);
  });

  it("drops a session.spawned event with no data at all", async () => {
    const { result } = await mounted();

    emit({ event: "session.spawned", id: "sess_rootaaa" });

    expect(Object.keys(result.current.nodes)).toEqual(["sess_rootaaa"]);
  });

  it("accumulates steps per node, keyed by the emitting session", async () => {
    const { result } = await mounted();
    emit(
      spawnEvent("sess_rootaaa", { child_session_id: "sess_childxyz", agent_id: "agent_ic" }),
    );

    emit(stepEvent("sess_rootaaa", { kind: "agent", event_id: "r1", content: "root" }));
    emit(stepEvent("sess_childxyz", { kind: "tool_call", event_id: "c1", content: "kid" }));
    emit(stepEvent("sess_childxyz", { kind: "tool_result", event_id: "c2", content: "ok" }));

    expect(result.current.steps.sess_rootaaa?.map((s) => s.event_id)).toEqual(["r1"]);
    expect(result.current.steps.sess_childxyz?.map((s) => s.event_id)).toEqual(["c1", "c2"]);
  });

  it("drops steps from a session that is not in the tree", async () => {
    const { result } = await mounted();

    emit(stepEvent("sess_elsewher", { kind: "agent", event_id: "x1", content: "nope" }));

    expect(result.current.steps).toEqual({});
  });

  it("dedupes a replayed step on a tree node", async () => {
    const { result } = await mounted();
    const ev = stepEvent("sess_rootaaa", { kind: "agent", event_id: "r1", content: "root" });

    emit(ev);
    emit(ev);

    expect(result.current.steps.sess_rootaaa).toHaveLength(1);
  });

  it("drops an unparseable step on a known node", async () => {
    const { result } = await mounted();

    emit(stepEvent("sess_rootaaa", { kind: "heartbeat", event_id: "r1" }));

    expect(result.current.steps).toEqual({});
  });

  it("ignores every event while no root is subscribed", () => {
    const { result } = renderHook(() => useChatStreamTree(undefined));

    emit(spawnEvent("sess_rootaaa", { child_session_id: "sess_c", agent_id: "agent_ic" }));
    emit(stepEvent("sess_rootaaa", { kind: "agent", event_id: "r1", content: "x" }));

    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });
});
