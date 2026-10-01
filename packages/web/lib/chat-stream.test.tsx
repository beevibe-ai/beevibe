import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SessionTreeNode, SessionTreeResponse } from "@/lib/types/sessions";

// `useSseEvents` normally opens a shared EventSource. Capture the callbacks
// it is handed instead, so each test can push synthetic events in.
const listeners = new Set<(ev: BvEventLike) => void>();

interface BvEventLike {
  event: string;
  id: string;
  data?: Record<string, unknown>;
}

vi.mock("./sse", () => ({
  useSseEvents: (cb: (ev: BvEventLike) => void) => {
    // Mirror the real hook's effect semantics: subscribe on mount, drop the
    // stale closure whenever the callback identity changes.
    reactUseEffect(() => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }, [cb]);
  },
}));

vi.mock("./api/client", () => ({
  api: { sessions: { tree: vi.fn() } },
}));

import { useEffect as reactUseEffect } from "react";
import { useChatStream, useChatStreamTree } from "./chat-stream";
import { api } from "./api/client";

const treeMock = vi.mocked(api.sessions.tree);

function emit(ev: BvEventLike): void {
  act(() => {
    for (const cb of [...listeners]) cb(ev);
  });
}

function step(
  id: string,
  overrides: Record<string, unknown> = {},
): BvEventLike {
  return {
    event: "session.step",
    id,
    data: { event_id: "ev_1", kind: "tool_call", tool_name: "Read", content: "x", ...overrides },
  };
}

function node(id: string, parent: string | null): SessionTreeNode {
  return {
    id,
    short_id: id.slice(5, 11),
    parent_session_id: parent,
    agent_id: "agent_a",
    agent_label: "Alice",
    agent_hierarchy: "ic",
    task_id: null,
    task_short_id: null,
    task_title: null,
    type: "chat",
    status: "running",
    intent: "do the thing",
    started_at: null,
    completed_at: null,
  };
}

beforeEach(() => {
  listeners.clear();
  treeMock.mockReset();
  // Default: never-settling fetch, so cases that only care about SSE don't
  // race an unexpected hydration.
  treeMock.mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChatStream", () => {
  it("returns a stable empty array with no session id", () => {
    const { result } = renderHook(() => useChatStream(undefined));
    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession).toEqual({});

    // Events for any session are dropped while unsubscribed.
    emit(step("sess_abcdefgh"));
    expect(result.current.stepsBySession).toEqual({});
  });

  it("accumulates steps for the subscribed session", () => {
    const { result } = renderHook(() => useChatStream("sess_aaaaaaaa"));

    emit(step("sess_aaaaaaaa", { event_id: "ev_1", content: "first" }));
    emit(step("sess_aaaaaaaa", { event_id: "ev_2", content: "second" }));

    expect(result.current.steps.map((s) => s.content)).toEqual(["first", "second"]);
    expect(result.current.stepsBySession["sess_aaaaaaaa"]).toHaveLength(2);
  });

  it("ignores events for other sessions", () => {
    const { result } = renderHook(() => useChatStream("sess_aaaaaaaa"));

    emit(step("sess_bbbbbbbb", { event_id: "ev_other" }));

    expect(result.current.steps).toEqual([]);
  });

  it("dedups a replayed event_id", () => {
    const { result } = renderHook(() => useChatStream("sess_aaaaaaaa"));

    emit(step("sess_aaaaaaaa", { event_id: "ev_dup" }));
    emit(step("sess_aaaaaaaa", { event_id: "ev_dup" }));

    expect(result.current.steps).toHaveLength(1);
  });

  it("keeps a finished turn's steps when the session id moves on", () => {
    const { result, rerender } = renderHook(({ sid }) => useChatStream(sid), {
      initialProps: { sid: "sess_aaaaaaaa" as string | undefined },
    });
    emit(step("sess_aaaaaaaa", { event_id: "ev_1" }));

    // New turn → fresh `steps`, but the completed turn stays looked-up-able.
    rerender({ sid: "sess_bbbbbbbb" });
    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession["sess_aaaaaaaa"]).toHaveLength(1);

    emit(step("sess_bbbbbbbb", { event_id: "ev_2" }));
    expect(result.current.steps).toHaveLength(1);
    expect(Object.keys(result.current.stepsBySession).sort()).toEqual([
      "sess_aaaaaaaa",
      "sess_bbbbbbbb",
    ]);
  });

  it("accepts all four step kinds and rejects anything else", () => {
    const { result } = renderHook(() => useChatStream("sess_aaaaaaaa"));

    for (const kind of ["tool_call", "tool_result", "agent", "summary"]) {
      emit(step("sess_aaaaaaaa", { event_id: `ev_${kind}`, kind }));
    }
    expect(result.current.steps.map((s) => s.kind)).toEqual([
      "tool_call",
      "tool_result",
      "agent",
      "summary",
    ]);

    emit(step("sess_aaaaaaaa", { event_id: "ev_bad", kind: "something_else" }));
    emit(step("sess_aaaaaaaa", { event_id: "ev_missing", kind: undefined }));
    emit(step("sess_aaaaaaaa", { event_id: "ev_nonstring", kind: 7 }));
    expect(result.current.steps).toHaveLength(4);
  });

  it("ignores non-step events and steps with no payload", () => {
    const { result } = renderHook(() => useChatStream("sess_aaaaaaaa"));

    emit({ event: "task.updated", id: "sess_aaaaaaaa", data: { kind: "tool_call" } });
    emit({ event: "session.step", id: "sess_aaaaaaaa" });

    expect(result.current.steps).toEqual([]);
  });

  it("defaults a missing tool_name and content, and synthesizes an event_id", () => {
    const { result } = renderHook(() => useChatStream("sess_aaaaaaaa"));

    emit({
      event: "session.step",
      id: "sess_aaaaaaaa",
      data: { kind: "agent" },
    });

    const [only] = result.current.steps;
    expect(only.tool_name).toBeUndefined();
    expect(only.content).toBe("");
    // Falls back to `${ev.id}-${Date.now()}` when the server omits event_id.
    expect(only.event_id).toMatch(/^sess_aaaaaaaa-\d+$/);
    expect(only.received_at).toBeTypeOf("number");
  });

  it("coerces non-string tool_name and content to the defaults", () => {
    const { result } = renderHook(() => useChatStream("sess_aaaaaaaa"));

    emit(step("sess_aaaaaaaa", { event_id: "ev_1", tool_name: 42, content: { a: 1 } }));

    expect(result.current.steps[0].tool_name).toBeUndefined();
    expect(result.current.steps[0].content).toBe("");
  });
});

describe("useChatStreamTree", () => {
  it("returns the empty tree and skips the fetch with no root", () => {
    const { result } = renderHook(() => useChatStreamTree(undefined));

    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
    expect(treeMock).not.toHaveBeenCalled();
  });

  it("hydrates nodes and the children adjacency from /tree", async () => {
    const res: SessionTreeResponse = {
      root: node("sess_rootaaaa", null),
      descendants: [node("sess_kidaaaaa", "sess_rootaaaa"), node("sess_kidbbbbb", "sess_rootaaaa")],
    };
    treeMock.mockResolvedValue(res);

    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));

    await waitFor(() => expect(Object.keys(result.current.nodes)).toHaveLength(3));
    expect(treeMock).toHaveBeenCalledWith("sess_rootaaaa");
    expect(result.current.children["sess_rootaaaa"].sort()).toEqual([
      "sess_kidaaaaa",
      "sess_kidbbbbb",
    ]);
    // The root has no parent, so it contributes no adjacency entry.
    expect(result.current.children["sess_rootaaaa"]).toBeDefined();
    expect(Object.keys(result.current.children)).toEqual(["sess_rootaaaa"]);
  });

  it("survives a failed /tree fetch and still takes SSE spawns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    treeMock.mockRejectedValue(new Error("offline"));

    renderHook(() => useChatStreamTree("sess_rootaaaa"));

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toContain("/tree fetch failed");
  });

  it("resets to the empty tree when the root goes away", async () => {
    treeMock.mockResolvedValue({ root: node("sess_rootaaaa", null), descendants: [] });
    const { result, rerender } = renderHook(({ root }) => useChatStreamTree(root), {
      initialProps: { root: "sess_rootaaaa" as string | undefined },
    });
    await waitFor(() => expect(result.current.nodes["sess_rootaaaa"]).toBeDefined());

    rerender({ root: undefined });
    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });

  it("attaches a spawned child of a known parent with placeholder metadata", async () => {
    treeMock.mockResolvedValue({ root: node("sess_rootaaaa", null), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));
    await waitFor(() => expect(result.current.nodes["sess_rootaaaa"]).toBeDefined());

    emit({
      event: "session.spawned",
      id: "sess_rootaaaa",
      data: {
        child_session_id: "sess_kidaaaaa",
        agent_id: "agent_b",
        task_id: "task_xyz1234",
        intent: "subtask",
      },
    });

    const child = result.current.nodes["sess_kidaaaaa"];
    expect(child).toMatchObject({
      id: "sess_kidaaaaa",
      short_id: "kidaaa",
      parent_session_id: "sess_rootaaaa",
      agent_id: "agent_b",
      // Payload carries no label/hierarchy — placeholders until /tree refetches.
      agent_label: "agent_b",
      agent_hierarchy: "ic",
      task_id: "task_xyz1234",
      task_short_id: "xyz123",
      type: "task",
      status: "pending",
      intent: "subtask",
    });
    expect(result.current.children["sess_rootaaaa"]).toEqual(["sess_kidaaaaa"]);
  });

  it("drops a spawn whose parent is not in the tree", async () => {
    treeMock.mockResolvedValue({ root: node("sess_rootaaaa", null), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));
    await waitFor(() => expect(result.current.nodes["sess_rootaaaa"]).toBeDefined());

    emit({
      event: "session.spawned",
      id: "sess_strangr",
      data: { child_session_id: "sess_kidaaaaa", agent_id: "agent_b" },
    });

    expect(result.current.nodes["sess_kidaaaaa"]).toBeUndefined();
  });

  it("dedups a repeated spawn and ignores an incomplete payload", async () => {
    treeMock.mockResolvedValue({ root: node("sess_rootaaaa", null), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));
    await waitFor(() => expect(result.current.nodes["sess_rootaaaa"]).toBeDefined());

    const spawn = {
      event: "session.spawned",
      id: "sess_rootaaaa",
      data: { child_session_id: "sess_kidaaaaa", agent_id: "agent_b" },
    };
    emit(spawn);
    emit(spawn);
    expect(result.current.children["sess_rootaaaa"]).toEqual(["sess_kidaaaaa"]);

    // Missing child id / agent id → not a spawn.
    emit({ event: "session.spawned", id: "sess_rootaaaa", data: { agent_id: "agent_c" } });
    emit({ event: "session.spawned", id: "sess_rootaaaa", data: { child_session_id: "sess_z" } });
    emit({ event: "session.spawned", id: "sess_rootaaaa" });
    expect(Object.keys(result.current.nodes)).toHaveLength(2);
  });

  it("defaults a spawn's task fields and intent when absent", async () => {
    treeMock.mockResolvedValue({ root: node("sess_rootaaaa", null), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));
    await waitFor(() => expect(result.current.nodes["sess_rootaaaa"]).toBeDefined());

    emit({
      event: "session.spawned",
      id: "sess_rootaaaa",
      data: { child_session_id: "sess_kidaaaaa", agent_id: "agent_b" },
    });

    expect(result.current.nodes["sess_kidaaaaa"]).toMatchObject({
      task_id: null,
      task_short_id: null,
      intent: "",
    });
  });

  it("uses the raw id as short_id for an implausibly short child id", async () => {
    treeMock.mockResolvedValue({ root: node("sess_rootaaaa", null), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));
    await waitFor(() => expect(result.current.nodes["sess_rootaaaa"]).toBeDefined());

    emit({
      event: "session.spawned",
      id: "sess_rootaaaa",
      data: { child_session_id: "s_1", agent_id: "agent_b", task_id: "t_1" },
    });

    expect(result.current.nodes["s_1"]).toMatchObject({
      short_id: "s_1",
      // Same length guard on the task id.
      task_short_id: null,
    });
  });

  it("accumulates steps per session for known nodes only, with dedup", async () => {
    treeMock.mockResolvedValue({
      root: node("sess_rootaaaa", null),
      descendants: [node("sess_kidaaaaa", "sess_rootaaaa")],
    });
    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));
    await waitFor(() => expect(Object.keys(result.current.nodes)).toHaveLength(2));

    emit(step("sess_rootaaaa", { event_id: "ev_r1", content: "root work" }));
    emit(step("sess_kidaaaaa", { event_id: "ev_k1", content: "kid work" }));
    emit(step("sess_kidaaaaa", { event_id: "ev_k1", content: "kid work" })); // dup
    emit(step("sess_unknown1", { event_id: "ev_u1" })); // not in the tree

    expect(result.current.steps["sess_rootaaaa"].map((s) => s.content)).toEqual(["root work"]);
    expect(result.current.steps["sess_kidaaaaa"]).toHaveLength(1);
    expect(result.current.steps["sess_unknown1"]).toBeUndefined();
  });

  it("ignores a malformed step for a known node", async () => {
    treeMock.mockResolvedValue({ root: node("sess_rootaaaa", null), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));
    await waitFor(() => expect(result.current.nodes["sess_rootaaaa"]).toBeDefined());

    emit({ event: "session.step", id: "sess_rootaaaa", data: { kind: "nope" } });
    emit({ event: "task.updated", id: "sess_rootaaaa", data: { kind: "agent" } });

    expect(result.current.steps["sess_rootaaaa"]).toBeUndefined();
  });

  it("does not clobber a /tree node with a late spawn placeholder", async () => {
    treeMock.mockResolvedValue({
      root: node("sess_rootaaaa", null),
      descendants: [node("sess_kidaaaaa", "sess_rootaaaa")],
    });
    const { result } = renderHook(() => useChatStreamTree("sess_rootaaaa"));
    await waitFor(() => expect(Object.keys(result.current.nodes)).toHaveLength(2));

    emit({
      event: "session.spawned",
      id: "sess_rootaaaa",
      data: { child_session_id: "sess_kidaaaaa", agent_id: "agent_placeholder" },
    });

    // Richer /tree metadata survives the dedup guard.
    expect(result.current.nodes["sess_kidaaaaa"].agent_label).toBe("Alice");
  });

  it("drops a /tree response that lands after the root changed", async () => {
    let resolveFirst: ((r: SessionTreeResponse) => void) | undefined;
    treeMock.mockImplementationOnce(
      () => new Promise<SessionTreeResponse>((r) => (resolveFirst = r)),
    );
    treeMock.mockResolvedValue({ root: node("sess_second00", null), descendants: [] });

    const { result, rerender } = renderHook(({ root }) => useChatStreamTree(root), {
      initialProps: { root: "sess_firstaaa" as string | undefined },
    });

    rerender({ root: "sess_second00" });
    await waitFor(() => expect(result.current.nodes["sess_second00"]).toBeDefined());

    // The stale fetch resolves last; its cleanup flag must discard it.
    await act(async () => {
      resolveFirst?.({ root: node("sess_firstaaa", null), descendants: [] });
    });

    expect(result.current.nodes["sess_firstaaa"]).toBeUndefined();
  });
});
