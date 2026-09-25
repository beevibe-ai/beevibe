import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SessionTreeNode, SessionTreeResponse } from "@beevibe/api/views/types";

// The SSE bus is a module-level singleton in the real `./sse`; the mock
// keeps the same subscribe-on-mount / unsubscribe-on-callback-change
// lifecycle so resubscription on `sessionId` change is exercised too.
const h = vi.hoisted(() => ({
  listeners: new Set<(ev: { event: string; id: string; data?: Record<string, unknown> }) => void>(),
}));

vi.mock("./sse", async () => {
  const { useEffect } = await import("react");
  return {
    useSseEvents: (cb: (ev: never) => void) => {
      useEffect(() => {
        h.listeners.add(cb as never);
        return () => {
          h.listeners.delete(cb as never);
        };
      }, [cb]);
    },
  };
});

vi.mock("./api/client", () => ({
  api: { sessions: { tree: vi.fn() } },
}));

import { useChatStream, useChatStreamTree } from "./chat-stream";
import { api } from "./api/client";

const treeMock = vi.mocked(api.sessions.tree);

/** Push one event onto every live subscriber, inside `act`. */
function emit(ev: { event: string; id: string; data?: Record<string, unknown> }) {
  act(() => {
    for (const l of [...h.listeners]) l(ev);
  });
}

function step(sessionId: string, data: Record<string, unknown>) {
  return { event: "session.step", id: sessionId, data };
}

function node(overrides: Partial<SessionTreeNode> & { id: string }): SessionTreeNode {
  return {
    short_id: overrides.id.slice(5, 11),
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
    ...overrides,
  } as SessionTreeNode;
}

const ROOT = "sess_rootaaaa";
const CHILD = "sess_childbbb";

beforeEach(() => {
  h.listeners.clear();
  treeMock.mockReset();
  treeMock.mockResolvedValue({ root: node({ id: ROOT }), descendants: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useChatStream", () => {
  it("accumulates session.step events for the subscribed session, in arrival order", () => {
    const { result } = renderHook(() => useChatStream(ROOT));

    emit(step(ROOT, { event_id: "e1", kind: "tool_call", tool_name: "Bash", content: "ls" }));
    emit(step(ROOT, { event_id: "e2", kind: "tool_result", content: "a\nb" }));

    expect(result.current.steps.map((s) => s.event_id)).toEqual(["e1", "e2"]);
    expect(result.current.steps[0]).toMatchObject({
      kind: "tool_call",
      tool_name: "Bash",
      content: "ls",
    });
    expect(result.current.steps[0]?.received_at).toBeTypeOf("number");
    expect(result.current.stepsBySession[ROOT]).toHaveLength(2);
  });

  it("accepts all four step kinds", () => {
    const { result } = renderHook(() => useChatStream(ROOT));
    for (const kind of ["tool_call", "tool_result", "agent", "summary"]) {
      emit(step(ROOT, { event_id: kind, kind }));
    }
    expect(result.current.steps.map((s) => s.kind)).toEqual([
      "tool_call",
      "tool_result",
      "agent",
      "summary",
    ]);
  });

  it("ignores events for other sessions and non-step events", () => {
    const { result } = renderHook(() => useChatStream(ROOT));

    emit(step("sess_other", { event_id: "e1", kind: "agent" }));
    emit({ event: "task.updated", id: ROOT });
    emit({ event: "session.step", id: ROOT }); // no data payload

    expect(result.current.steps).toHaveLength(0);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("ignores a step whose kind is missing or unrecognized", () => {
    const { result } = renderHook(() => useChatStream(ROOT));

    emit(step(ROOT, { event_id: "e1" }));
    emit(step(ROOT, { event_id: "e2", kind: "thinking" }));
    emit(step(ROOT, { event_id: "e3", kind: 7 }));

    expect(result.current.steps).toHaveLength(0);
  });

  it("dedupes repeated event_ids", () => {
    const { result } = renderHook(() => useChatStream(ROOT));

    emit(step(ROOT, { event_id: "e1", kind: "agent", content: "first" }));
    emit(step(ROOT, { event_id: "e1", kind: "agent", content: "redelivered" }));

    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]?.content).toBe("first");
  });

  it("defaults a missing event_id to a session-scoped synthetic id, and coerces the rest", () => {
    const { result } = renderHook(() => useChatStream(ROOT));

    emit(step(ROOT, { kind: "agent", tool_name: 42, content: { not: "a string" } }));

    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]?.event_id).toMatch(new RegExp(`^${ROOT}-\\d+$`));
    expect(result.current.steps[0]?.tool_name).toBeUndefined();
    expect(result.current.steps[0]?.content).toBe("");
  });

  it("collects nothing while no session is subscribed", () => {
    const { result } = renderHook(() => useChatStream(undefined));
    emit(step(ROOT, { event_id: "e1", kind: "agent" }));
    expect(result.current.steps).toHaveLength(0);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("returns the same empty array identity when there is nothing to show", () => {
    const a = renderHook(() => useChatStream(undefined));
    const b = renderHook(() => useChatStream(ROOT));
    expect(a.result.current.steps).toBe(b.result.current.steps);
  });

  it("gives a new turn a fresh steps array while keeping the finished turn in the map", () => {
    const { result, rerender } = renderHook(({ sid }: { sid: string }) => useChatStream(sid), {
      initialProps: { sid: ROOT },
    });

    emit(step(ROOT, { event_id: "e1", kind: "agent", content: "turn one" }));
    expect(result.current.steps).toHaveLength(1);

    rerender({ sid: CHILD });
    expect(result.current.steps).toHaveLength(0);

    emit(step(CHILD, { event_id: "e2", kind: "agent", content: "turn two" }));
    expect(result.current.steps.map((s) => s.content)).toEqual(["turn two"]);
    // The completed turn is still looked up by its own session id.
    expect(result.current.stepsBySession[ROOT]?.[0]?.content).toBe("turn one");
  });
});

describe("useChatStreamTree — cold-mount hydration", () => {
  it("does not fetch and stays empty while there is no root", () => {
    const { result } = renderHook(() => useChatStreamTree(undefined));
    expect(treeMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });

  it("hydrates root plus descendants from /tree and derives the adjacency", async () => {
    treeMock.mockResolvedValue({
      root: node({ id: ROOT }),
      descendants: [node({ id: CHILD, parent_session_id: ROOT, agent_hierarchy: "ic" })],
    });

    const { result } = renderHook(() => useChatStreamTree(ROOT));

    await waitFor(() => expect(Object.keys(result.current.nodes)).toHaveLength(2));
    expect(treeMock).toHaveBeenCalledWith(ROOT);
    expect(result.current.nodes[CHILD]?.parent_session_id).toBe(ROOT);
    expect(result.current.children).toEqual({ [ROOT]: [CHILD] });
  });

  it("warns but keeps working when the /tree fetch rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    treeMock.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useChatStreamTree(ROOT));

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0]?.[0]).toContain("[chat-stream]");
    expect(result.current.nodes).toEqual({});
    warn.mockRestore();
  });

  it("resets to the empty tree when the root goes away", async () => {
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | undefined }) => useChatStreamTree(sid),
      { initialProps: { sid: ROOT as string | undefined } },
    );
    await waitFor(() => expect(result.current.nodes[ROOT]).toBeDefined());

    rerender({ sid: undefined });
    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });

  it("drops a /tree response that lands after the root changed", async () => {
    let resolveFirst: (v: SessionTreeResponse) => void = () => {};
    treeMock.mockImplementationOnce(
      () =>
        new Promise<SessionTreeResponse>((resolve) => {
          resolveFirst = resolve;
        }) as ReturnType<typeof api.sessions.tree>,
    );
    treeMock.mockResolvedValue({ root: node({ id: CHILD }), descendants: [] });

    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useChatStreamTree(sid),
      { initialProps: { sid: ROOT } },
    );
    rerender({ sid: CHILD });
    await waitFor(() => expect(result.current.nodes[CHILD]).toBeDefined());

    await act(async () => {
      resolveFirst({ root: node({ id: ROOT }), descendants: [] });
    });

    expect(result.current.nodes[ROOT]).toBeUndefined();
  });
});

describe("useChatStreamTree — live spawn events", () => {
  it("attaches a spawned child to a known parent with placeholder metadata", async () => {
    const { result } = renderHook(() => useChatStreamTree(ROOT));
    await waitFor(() => expect(result.current.nodes[ROOT]).toBeDefined());

    emit({
      event: "session.spawned",
      id: ROOT,
      data: {
        child_session_id: CHILD,
        agent_id: "agent_ic",
        task_id: "task_abcdefgh",
        intent: "ship the thing",
      },
    });

    expect(result.current.nodes[CHILD]).toMatchObject({
      id: CHILD,
      short_id: CHILD.slice(5, 11),
      parent_session_id: ROOT,
      agent_id: "agent_ic",
      // Placeholders until the /tree refetch fills them in.
      agent_label: "agent_ic",
      agent_hierarchy: "ic",
      task_id: "task_abcdefgh",
      task_short_id: "abcdef",
      type: "task",
      status: "pending",
      intent: "ship the thing",
    });
    expect(result.current.children[ROOT]).toEqual([CHILD]);
  });

  it("falls back to the whole id when it is too short to slice a short_id from", async () => {
    treeMock.mockResolvedValue({ root: node({ id: "sess_a" }), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_a"));
    await waitFor(() => expect(result.current.nodes["sess_a"]).toBeDefined());

    emit({
      event: "session.spawned",
      id: "sess_a",
      data: { child_session_id: "s_b", agent_id: "agent_ic" },
    });

    expect(result.current.nodes["s_b"]).toMatchObject({
      short_id: "s_b",
      task_id: null,
      task_short_id: null,
      intent: "",
    });
  });

  it("ignores a spawn whose parent is not already in the tree", async () => {
    const { result } = renderHook(() => useChatStreamTree(ROOT));
    await waitFor(() => expect(result.current.nodes[ROOT]).toBeDefined());

    emit({
      event: "session.spawned",
      id: "sess_unrelated",
      data: { child_session_id: "sess_stranger", agent_id: "agent_x" },
    });

    expect(result.current.nodes["sess_stranger"]).toBeUndefined();
  });

  it("ignores a spawn payload missing the child id or the agent id", async () => {
    const { result } = renderHook(() => useChatStreamTree(ROOT));
    await waitFor(() => expect(result.current.nodes[ROOT]).toBeDefined());

    emit({ event: "session.spawned", id: ROOT, data: { agent_id: "agent_ic" } });
    emit({ event: "session.spawned", id: ROOT, data: { child_session_id: CHILD } });
    emit({ event: "session.spawned", id: ROOT });

    expect(Object.keys(result.current.nodes)).toEqual([ROOT]);
  });

  it("dedupes a redelivered spawn for a child it already has", async () => {
    treeMock.mockResolvedValue({
      root: node({ id: ROOT }),
      descendants: [node({ id: CHILD, parent_session_id: ROOT, agent_label: "Real Label" })],
    });
    const { result } = renderHook(() => useChatStreamTree(ROOT));
    await waitFor(() => expect(result.current.nodes[CHILD]).toBeDefined());

    emit({
      event: "session.spawned",
      id: ROOT,
      data: { child_session_id: CHILD, agent_id: "agent_ic" },
    });

    // The richer /tree node survives; the placeholder does not clobber it.
    expect(result.current.nodes[CHILD]?.agent_label).toBe("Real Label");
    expect(result.current.children[ROOT]).toEqual([CHILD]);
  });
});

describe("useChatStreamTree — live step events", () => {
  it("files steps under the node they belong to", async () => {
    treeMock.mockResolvedValue({
      root: node({ id: ROOT }),
      descendants: [node({ id: CHILD, parent_session_id: ROOT })],
    });
    const { result } = renderHook(() => useChatStreamTree(ROOT));
    await waitFor(() => expect(result.current.nodes[CHILD]).toBeDefined());

    emit(step(ROOT, { event_id: "r1", kind: "agent", content: "root turn" }));
    emit(step(CHILD, { event_id: "c1", kind: "tool_call", content: "child turn" }));
    emit(step(CHILD, { event_id: "c2", kind: "tool_result", content: "child result" }));

    expect(result.current.steps[ROOT]?.map((s) => s.event_id)).toEqual(["r1"]);
    expect(result.current.steps[CHILD]?.map((s) => s.event_id)).toEqual(["c1", "c2"]);
  });

  it("drops steps for sessions outside the tree", async () => {
    const { result } = renderHook(() => useChatStreamTree(ROOT));
    await waitFor(() => expect(result.current.nodes[ROOT]).toBeDefined());

    emit(step("sess_stranger", { event_id: "x1", kind: "agent" }));

    expect(result.current.steps).toEqual({});
  });

  it("dedupes a redelivered step", async () => {
    const { result } = renderHook(() => useChatStreamTree(ROOT));
    await waitFor(() => expect(result.current.nodes[ROOT]).toBeDefined());

    emit(step(ROOT, { event_id: "r1", kind: "agent", content: "once" }));
    emit(step(ROOT, { event_id: "r1", kind: "agent", content: "again" }));

    expect(result.current.steps[ROOT]).toHaveLength(1);
    expect(result.current.steps[ROOT]?.[0]?.content).toBe("once");
  });

  it("collects nothing while there is no root", () => {
    const { result } = renderHook(() => useChatStreamTree(undefined));
    emit(step(ROOT, { event_id: "r1", kind: "agent" }));
    expect(result.current.steps).toEqual({});
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useChatStreamTree(ROOT));
    await waitFor(() => expect(h.listeners.size).toBe(1));
    unmount();
    expect(h.listeners.size).toBe(0);
  });
});
