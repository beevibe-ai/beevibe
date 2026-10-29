/**
 * useChatStream / useChatStreamTree — the chat UI's live working trace.
 *
 * Both hooks fold an unfiltered SSE bus into per-session state, so the
 * filtering is the whole feature: a `session.step` for someone else's
 * session must not land in this chat, and a `session.spawned` whose
 * parent isn't in the tree must not drag an unrelated session in. The
 * event_id dedup matters because SSE redelivers on reconnect, and the
 * per-session map has to survive a turn change — a finished turn still
 * renders its trace from `stepsBySession`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SessionTreeNode, SessionTreeResponse } from "@beevibe/api/views/types";

type Listener = (ev: { event: string; id: string; data?: Record<string, unknown> }) => void;

const listeners = new Set<Listener>();

vi.mock("./sse", () => ({
  useSseEvents: (cb: Listener) => {
    // Mirror the real hook: subscribe for the life of the callback identity.
    useEffect(() => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }, [cb]);
  },
}));

const treeFetch = vi.fn<(id: string) => Promise<SessionTreeResponse>>();

vi.mock("./api/client", () => ({
  api: { sessions: { tree: (id: string) => treeFetch(id) } },
}));

import { useChatStream, useChatStreamTree } from "./chat-stream";

function emit(ev: { event: string; id: string; data?: Record<string, unknown> }) {
  act(() => {
    for (const l of [...listeners]) l(ev);
  });
}

function step(
  id: string,
  data: Record<string, unknown>,
): { event: string; id: string; data: Record<string, unknown> } {
  return { event: "session.step", id, data };
}

function node(overrides: Partial<SessionTreeNode> & { id: string }): SessionTreeNode {
  return {
    short_id: overrides.id.slice(5, 11),
    parent_session_id: null,
    agent_id: "agent_1",
    agent_label: "Scout",
    agent_hierarchy: "ic",
    task_id: null,
    task_short_id: null,
    task_title: null,
    type: "chat",
    status: "running",
    intent: "",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  listeners.clear();
  treeFetch.mockReset();
  treeFetch.mockResolvedValue({ root: node({ id: "sess_root01" }), descendants: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChatStream", () => {
  it("starts empty and stays empty without a session id", () => {
    const { result } = renderHook(() => useChatStream(undefined));

    emit(step("sess_a", { kind: "tool_call", event_id: "evt_1" }));

    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("accumulates steps for the subscribed session in arrival order", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit(step("sess_a", { kind: "tool_call", event_id: "evt_1", tool_name: "Bash" }));
    emit(step("sess_a", { kind: "tool_result", event_id: "evt_2", content: "ok" }));

    expect(result.current.steps.map((s) => [s.kind, s.event_id, s.tool_name])).toEqual([
      ["tool_call", "evt_1", "Bash"],
      ["tool_result", "evt_2", undefined],
    ]);
    expect(result.current.steps[1]!.content).toBe("ok");
  });

  it("ignores steps for a different session on the same bus", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit(step("sess_b", { kind: "agent", event_id: "evt_other" }));

    expect(result.current.stepsBySession).toEqual({});
  });

  it("dedups a redelivered event_id", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit(step("sess_a", { kind: "agent", event_id: "evt_1" }));
    emit(step("sess_a", { kind: "agent", event_id: "evt_1" }));

    expect(result.current.steps).toHaveLength(1);
  });

  it.each(["summary", "agent", "tool_call", "tool_result"])("accepts kind=%s", (kind) => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(step("sess_a", { kind, event_id: `evt_${kind}` }));
    expect(result.current.steps).toHaveLength(1);
  });

  it.each([
    ["an unknown kind", { kind: "thinking", event_id: "evt_1" }],
    ["a non-string kind", { kind: 7, event_id: "evt_1" }],
    ["no kind at all", { event_id: "evt_1" }],
  ])("drops a step with %s", (_label, data) => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(step("sess_a", data as Record<string, unknown>));
    expect(result.current.steps).toEqual([]);
  });

  it("drops a non-step event and a step event with no data", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit({ event: "task.updated", id: "sess_a", data: { kind: "agent", event_id: "e" } });
    emit({ event: "session.step", id: "sess_a" });

    expect(result.current.steps).toEqual([]);
  });

  it("defaults a missing content to the empty string and a missing tool_name to undefined", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit(step("sess_a", { kind: "agent", event_id: "evt_1", content: 5, tool_name: 5 }));

    expect(result.current.steps[0]).toMatchObject({ content: "", tool_name: undefined });
  });

  it("synthesizes an event_id from the session id when the payload omits one", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { result } = renderHook(() => useChatStream("sess_a"));

    emit(step("sess_a", { kind: "agent" }));

    expect(result.current.steps[0]!.event_id).toBe("sess_a-1700000000000");
    expect(result.current.steps[0]!.received_at).toBe(1_700_000_000_000);
  });

  it("keeps a finished turn's steps in stepsBySession after the session id changes", () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useChatStream(id), {
      initialProps: { id: "sess_a" },
    });

    emit(step("sess_a", { kind: "agent", event_id: "evt_1" }));
    rerender({ id: "sess_b" });

    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession.sess_a).toHaveLength(1);

    emit(step("sess_b", { kind: "agent", event_id: "evt_2" }));

    expect(result.current.steps).toHaveLength(1);
    expect(Object.keys(result.current.stepsBySession).sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("returns a stable empty array for a session with no steps yet", () => {
    const { result, rerender } = renderHook(() => useChatStream("sess_a"));
    const first = result.current.steps;
    rerender();
    expect(result.current.steps).toBe(first);
  });
});

describe("useChatStreamTree hydration", () => {
  it("does not fetch and ignores events without a root id", () => {
    const { result } = renderHook(() => useChatStreamTree(undefined));

    emit(step("sess_root01", { kind: "agent", event_id: "evt_1" }));
    emit({
      event: "session.spawned",
      id: "sess_root01",
      data: { child_session_id: "sess_kid001", agent_id: "a" },
    });

    expect(treeFetch).not.toHaveBeenCalled();
    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });

  it("drops a /tree response that lands after unmount", async () => {
    let resolveTree: (res: SessionTreeResponse) => void = () => {};
    treeFetch.mockReturnValue(
      new Promise<SessionTreeResponse>((resolve) => {
        resolveTree = resolve;
      }),
    );
    const { unmount } = renderHook(() => useChatStreamTree("sess_root01"));

    unmount();
    await act(async () => {
      resolveTree({ root: node({ id: "sess_root01" }), descendants: [] });
    });

    // Nothing to assert on the (gone) hook state — the point is that the
    // late resolve neither throws nor sets state on an unmounted tree.
    expect(treeFetch).toHaveBeenCalledTimes(1);
  });

  it("hydrates nodes and the parent→children adjacency from /tree", async () => {
    treeFetch.mockResolvedValue({
      root: node({ id: "sess_root01" }),
      descendants: [
        node({ id: "sess_kid001", parent_session_id: "sess_root01" }),
        node({ id: "sess_kid002", parent_session_id: "sess_root01" }),
        node({ id: "sess_grand01", parent_session_id: "sess_kid001" }),
      ],
    });

    const { result } = renderHook(() => useChatStreamTree("sess_root01"));

    await waitFor(() => expect(Object.keys(result.current.nodes)).toHaveLength(4));
    expect(treeFetch).toHaveBeenCalledWith("sess_root01");
    expect(result.current.children).toEqual({
      sess_root01: ["sess_kid001", "sess_kid002"],
      sess_kid001: ["sess_grand01"],
    });
  });

  it("refetches and replaces the tree when the root changes", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useChatStreamTree(id),
      { initialProps: { id: "sess_root01" as string | undefined } },
    );
    await waitFor(() => expect(result.current.nodes.sess_root01).toBeDefined());

    treeFetch.mockResolvedValue({ root: node({ id: "sess_root02" }), descendants: [] });
    rerender({ id: "sess_root02" });

    await waitFor(() => expect(result.current.nodes.sess_root02).toBeDefined());
    expect(treeFetch).toHaveBeenLastCalledWith("sess_root02");
  });

  it("clears the tree when the root goes away", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useChatStreamTree(id),
      { initialProps: { id: "sess_root01" as string | undefined } },
    );
    await waitFor(() => expect(result.current.nodes.sess_root01).toBeDefined());

    rerender({ id: undefined });

    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });

  it("survives a failed /tree fetch and still takes live events", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    treeFetch.mockRejectedValue(new Error("502"));

    const { result } = renderHook(() => useChatStreamTree("sess_root01"));

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current.nodes).toEqual({});
  });
});

describe("useChatStreamTree live events", () => {
  async function mounted(descendants: SessionTreeNode[] = []) {
    treeFetch.mockResolvedValue({ root: node({ id: "sess_root01" }), descendants });
    const hook = renderHook(() => useChatStreamTree("sess_root01"));
    await waitFor(() => expect(hook.result.current.nodes.sess_root01).toBeDefined());
    return hook;
  }

  it("attaches a spawned child to a known parent and rebuilds adjacency", async () => {
    const { result } = await mounted();

    emit({
      event: "session.spawned",
      id: "sess_root01",
      data: { child_session_id: "sess_kid001", agent_id: "agent_ic", intent: "do the thing" },
    });

    expect(result.current.children.sess_root01).toEqual(["sess_kid001"]);
    expect(result.current.nodes.sess_kid001).toMatchObject({
      id: "sess_kid001",
      parent_session_id: "sess_root01",
      agent_id: "agent_ic",
      agent_label: "agent_ic",
      agent_hierarchy: "ic",
      type: "task",
      status: "pending",
      intent: "do the thing",
      short_id: "kid001",
    });
  });

  it("derives the task short id from the spawn payload's task_id", async () => {
    const { result } = await mounted();

    emit({
      event: "session.spawned",
      id: "sess_root01",
      data: { child_session_id: "sess_kid001", agent_id: "a", task_id: "task_abcdef01" },
    });

    expect(result.current.nodes.sess_kid001).toMatchObject({
      task_id: "task_abcdef01",
      task_short_id: "abcdef",
    });
  });

  it("leaves task fields null and intent blank when the payload omits them", async () => {
    const { result } = await mounted();

    emit({
      event: "session.spawned",
      id: "sess_root01",
      data: { child_session_id: "sess_kid001", agent_id: "a", task_id: 7, intent: 7 },
    });

    expect(result.current.nodes.sess_kid001).toMatchObject({
      task_id: null,
      task_short_id: null,
      intent: "",
    });
  });

  it("falls back to the full id as short_id for an id shorter than the prefix+6", async () => {
    const { result } = await mounted();

    emit({
      event: "session.spawned",
      id: "sess_root01",
      data: { child_session_id: "short", agent_id: "a" },
    });

    expect(result.current.nodes.short).toMatchObject({ short_id: "short" });
  });

  it("ignores a spawn whose parent is not in the tree", async () => {
    const { result } = await mounted();

    emit({
      event: "session.spawned",
      id: "sess_stranger",
      data: { child_session_id: "sess_kid001", agent_id: "a" },
    });

    expect(result.current.nodes.sess_kid001).toBeUndefined();
  });

  it("dedups a redelivered spawn", async () => {
    const { result } = await mounted();
    const spawn = {
      event: "session.spawned",
      id: "sess_root01",
      data: { child_session_id: "sess_kid001", agent_id: "a" },
    };

    emit(spawn);
    const afterFirst = result.current.nodes.sess_kid001;
    emit(spawn);

    expect(result.current.nodes.sess_kid001).toBe(afterFirst);
    expect(result.current.children.sess_root01).toEqual(["sess_kid001"]);
  });

  it.each([
    ["no child id", { agent_id: "a" }],
    ["no agent id", { child_session_id: "sess_kid001" }],
    ["a non-string child id", { child_session_id: 5, agent_id: "a" }],
  ])("ignores a spawn payload with %s", async (_label, data) => {
    const { result } = await mounted();

    emit({ event: "session.spawned", id: "sess_root01", data: data as Record<string, unknown> });

    expect(Object.keys(result.current.nodes)).toEqual(["sess_root01"]);
  });

  it("accumulates steps per node, for the root and for a descendant", async () => {
    const { result } = await mounted([
      node({ id: "sess_kid001", parent_session_id: "sess_root01" }),
    ]);

    emit(step("sess_root01", { kind: "agent", event_id: "evt_r" }));
    emit(step("sess_kid001", { kind: "tool_call", event_id: "evt_k" }));

    expect(result.current.steps.sess_root01).toHaveLength(1);
    expect(result.current.steps.sess_kid001?.[0]).toMatchObject({ event_id: "evt_k" });
  });

  it("accepts steps for a session that only a spawn event introduced", async () => {
    const { result } = await mounted();
    emit({
      event: "session.spawned",
      id: "sess_root01",
      data: { child_session_id: "sess_kid001", agent_id: "a" },
    });

    emit(step("sess_kid001", { kind: "agent", event_id: "evt_1" }));

    expect(result.current.steps.sess_kid001).toHaveLength(1);
  });

  it("ignores steps for a session outside the tree", async () => {
    const { result } = await mounted();

    emit(step("sess_stranger", { kind: "agent", event_id: "evt_1" }));

    expect(result.current.steps).toEqual({});
  });

  it("dedups a redelivered step within a node", async () => {
    const { result } = await mounted();

    emit(step("sess_root01", { kind: "agent", event_id: "evt_1" }));
    emit(step("sess_root01", { kind: "agent", event_id: "evt_1" }));

    expect(result.current.steps.sess_root01).toHaveLength(1);
  });

  it("does not let a /tree response clobber steps already collected", async () => {
    const { result } = await mounted();

    emit(step("sess_root01", { kind: "agent", event_id: "evt_1" }));
    expect(result.current.steps.sess_root01).toHaveLength(1);

    // A second hydration (the invalidation after a spawn) merges nodes but
    // must leave the step log alone.
    treeFetch.mockResolvedValue({
      root: node({ id: "sess_root01", status: "succeeded" }),
      descendants: [],
    });
    emit({
      event: "session.spawned",
      id: "sess_root01",
      data: { child_session_id: "sess_kid001", agent_id: "a" },
    });

    expect(result.current.steps.sess_root01).toHaveLength(1);
  });
});
