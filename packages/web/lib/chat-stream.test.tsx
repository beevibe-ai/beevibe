import { act, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BvEvent } from "./sse";
import type { SessionTreeNode, SessionTreeResponse } from "./types/sessions";

/**
 * `useChatStream` / `useChatStreamTree` accumulate `session.step` and
 * `session.spawned` SSE events into the working trace the chat UI
 * renders. Both are pure reducers over an event stream once the two
 * boundaries are stubbed, so the whole module is testable without a
 * live EventSource:
 *
 *   - `./sse` is replaced with a controllable emitter, so a test drives
 *     the exact event sequence (including the out-of-order and
 *     duplicate deliveries a real bus produces).
 *   - `./api/client`'s `sessions.tree` is stubbed so the cold-mount
 *     hydration can be resolved, deferred, or rejected on demand.
 *
 * The behaviors worth pinning are the ones that keep the UI honest
 * against a shared, at-least-once event bus: per-session scoping
 * (events for other sessions must not leak into this trace),
 * deduplication by `event_id`, and the tree variant's refusal to attach
 * sessions whose parent it doesn't already know — without that last
 * one, every unrelated spawn on the bus would pile into the tree.
 */

/** Registered SSE listeners, in subscription order. */
const listeners = new Set<(e: BvEvent) => void>();

vi.mock("./sse", () => ({
  useSseEvents: (cb: (e: BvEvent) => void) => {
    // Mirror the real hook: re-subscribe whenever the callback identity
    // changes, so a stale-closure regression in the hooks under test
    // shows up here too.
    useEffect(() => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }, [cb]);
  },
}));

const treeMock = vi.fn<(id: string) => Promise<SessionTreeResponse>>();

vi.mock("./api/client", () => ({
  api: { sessions: { tree: (id: string) => treeMock(id) } },
}));

const { useChatStream, useChatStreamTree } = await import("./chat-stream");

function emit(ev: BvEvent) {
  act(() => {
    for (const cb of [...listeners]) cb(ev);
  });
}

function stepEvent(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): BvEvent {
  return {
    event: "session.step",
    id: sessionId,
    data: {
      event_id: "evt_1",
      kind: "tool_call",
      tool_name: "Bash",
      content: "ls -la",
      ...overrides,
    },
  };
}

function spawnEvent(
  parentId: string,
  overrides: Record<string, unknown> = {},
): BvEvent {
  return {
    event: "session.spawned",
    id: parentId,
    data: {
      child_session_id: "sess_child",
      agent_id: "agent_ic",
      task_id: "task_abcdefghij",
      intent: "do the subtask",
      ...overrides,
    },
  };
}

function node(overrides: Partial<SessionTreeNode> = {}): SessionTreeNode {
  return {
    id: "sess_root",
    short_id: "root01",
    parent_session_id: null,
    agent_id: "agent_team",
    agent_label: "Team Lead",
    agent_hierarchy: "team",
    task_id: null,
    task_short_id: null,
    task_title: null,
    type: "chat",
    status: "running",
    intent: "the root chat",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  listeners.clear();
  treeMock.mockReset();
  treeMock.mockResolvedValue({ root: node(), descendants: [] });
});

describe("useChatStream — accumulation", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("collects a step for the subscribed session", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a"));

    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]).toMatchObject({
      event_id: "evt_1",
      kind: "tool_call",
      tool_name: "Bash",
      content: "ls -la",
    });
    expect(typeof result.current.steps[0]!.received_at).toBe("number");
  });

  it("appends steps in arrival order", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a", { event_id: "evt_1", content: "first" }));
    emit(stepEvent("sess_a", { event_id: "evt_2", content: "second" }));

    expect(result.current.steps.map((s) => s.content)).toEqual(["first", "second"]);
  });

  it("dedupes a redelivered event_id", () => {
    // The bus is at-least-once; a duplicate must not double-render.
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a", { event_id: "evt_1" }));
    emit(stepEvent("sess_a", { event_id: "evt_1", content: "resent" }));

    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]!.content).toBe("ls -la");
  });

  it("accepts all four step kinds", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    for (const kind of ["tool_call", "tool_result", "agent", "summary"]) {
      emit(stepEvent("sess_a", { event_id: `evt_${kind}`, kind }));
    }
    expect(result.current.steps.map((s) => s.kind)).toEqual([
      "tool_call",
      "tool_result",
      "agent",
      "summary",
    ]);
  });

  it("keeps a completed turn's steps in stepsBySession after the id changes", () => {
    // A finished turn still renders its trace as a collapsed disclosure,
    // looked up by the agent message's session_id.
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | undefined }) => useChatStream(sid),
      { initialProps: { sid: "sess_turn1" as string | undefined } },
    );
    emit(stepEvent("sess_turn1", { event_id: "evt_1" }));
    expect(result.current.steps).toHaveLength(1);

    rerender({ sid: "sess_turn2" });
    // Fresh array for the new turn...
    expect(result.current.steps).toEqual([]);
    // ...but the old turn is still retrievable.
    expect(result.current.stepsBySession.sess_turn1).toHaveLength(1);

    emit(stepEvent("sess_turn2", { event_id: "evt_2" }));
    expect(result.current.steps).toHaveLength(1);
    expect(Object.keys(result.current.stepsBySession).sort()).toEqual([
      "sess_turn1",
      "sess_turn2",
    ]);
  });
});

describe("useChatStream — scoping and filtering", () => {
  it("ignores steps for a different session", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_other"));
    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("ignores every event while sessionId is undefined", () => {
    const { result } = renderHook(() => useChatStream(undefined));
    emit(stepEvent("sess_a"));
    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("ignores non-step events and events with no payload", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit({ event: "task.updated", id: "sess_a", data: { kind: "tool_call" } });
    emit({ event: "session.step", id: "sess_a" });
    expect(result.current.steps).toEqual([]);
  });

  it("ignores a step with an unknown or missing kind", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a", { kind: "thinking" }));
    emit(stepEvent("sess_a", { kind: undefined }));
    emit(stepEvent("sess_a", { kind: 5 }));
    expect(result.current.steps).toEqual([]);
  });

  it("returns a stable empty array rather than a fresh one each render", () => {
    // Chat re-renders constantly; a new [] each time would churn every
    // memo downstream of `steps`.
    const { result, rerender } = renderHook(() => useChatStream("sess_a"));
    const first = result.current.steps;
    rerender();
    expect(result.current.steps).toBe(first);
  });
});

describe("useChatStream — field coercion", () => {
  it("defaults a non-string content to an empty string", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a", { content: undefined }));
    expect(result.current.steps[0]!.content).toBe("");
  });

  it("leaves tool_name undefined when absent or not a string", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a", { event_id: "evt_1", tool_name: undefined }));
    emit(stepEvent("sess_a", { event_id: "evt_2", tool_name: 42 }));
    expect(result.current.steps[0]!.tool_name).toBeUndefined();
    expect(result.current.steps[1]!.tool_name).toBeUndefined();
  });

  it("synthesizes an event_id from the session id when the payload omits one", () => {
    const { result } = renderHook(() => useChatStream("sess_a"));
    emit(stepEvent("sess_a", { event_id: undefined }));
    expect(result.current.steps[0]!.event_id).toMatch(/^sess_a-\d+$/);
  });

  it("still dedupes nothing when ids are synthesized distinctly", () => {
    // Synthesized ids embed Date.now(), so two payloads without an
    // event_id are kept as separate steps rather than collapsing.
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useChatStream("sess_a"));
      emit(stepEvent("sess_a", { event_id: undefined, content: "a" }));
      vi.advanceTimersByTime(5);
      emit(stepEvent("sess_a", { event_id: undefined, content: "b" }));
      expect(result.current.steps.map((s) => s.content)).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useChatStreamTree — hydration", () => {
  it("fetches the tree for the root and stores the root node", async () => {
    const { result } = renderHook(() => useChatStreamTree("sess_root"));
    await waitFor(() => expect(result.current.nodes.sess_root).toBeDefined());

    expect(treeMock).toHaveBeenCalledWith("sess_root");
    expect(result.current.nodes.sess_root).toMatchObject({ agent_label: "Team Lead" });
    expect(result.current.children).toEqual({});
    expect(result.current.steps).toEqual({});
  });

  it("stores descendants and derives the parent → children adjacency", async () => {
    treeMock.mockResolvedValue({
      root: node(),
      descendants: [
        node({ id: "sess_c1", parent_session_id: "sess_root", type: "task" }),
        node({ id: "sess_c2", parent_session_id: "sess_root", type: "task" }),
        node({ id: "sess_g1", parent_session_id: "sess_c1", type: "task" }),
      ],
    });
    const { result } = renderHook(() => useChatStreamTree("sess_root"));
    await waitFor(() => expect(Object.keys(result.current.nodes)).toHaveLength(4));

    expect(result.current.children.sess_root).toEqual(["sess_c1", "sess_c2"]);
    expect(result.current.children.sess_c1).toEqual(["sess_g1"]);
    expect(result.current.children.sess_g1).toBeUndefined();
  });

  it("stays empty and skips the fetch with no root id", () => {
    const { result } = renderHook(() => useChatStreamTree(undefined));
    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
    expect(treeMock).not.toHaveBeenCalled();
  });

  it("refetches and resets when the root id changes", async () => {
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | undefined }) => useChatStreamTree(sid),
      { initialProps: { sid: "sess_root" as string | undefined } },
    );
    await waitFor(() => expect(result.current.nodes.sess_root).toBeDefined());

    treeMock.mockResolvedValue({ root: node({ id: "sess_root2" }), descendants: [] });
    rerender({ sid: "sess_root2" });
    await waitFor(() => expect(result.current.nodes.sess_root2).toBeDefined());
    expect(treeMock).toHaveBeenLastCalledWith("sess_root2");
  });

  it("clears the tree when the root id goes away", async () => {
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | undefined }) => useChatStreamTree(sid),
      { initialProps: { sid: "sess_root" as string | undefined } },
    );
    await waitFor(() => expect(result.current.nodes.sess_root).toBeDefined());

    rerender({ sid: undefined });
    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });

  it("survives a failed cold-mount fetch and still takes live events", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    treeMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useChatStreamTree("sess_root"));

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current.nodes).toEqual({});
    // A spawn whose parent is unknown is still correctly dropped — the
    // fetch failing must not turn into an open door.
    emit(spawnEvent("sess_root"));
    expect(result.current.nodes).toEqual({});
    warn.mockRestore();
  });

  it("ignores a tree response that resolves after the root changed", async () => {
    // The /tree fetch races the root switch; the stale response must not
    // repopulate the tree for a root we've navigated away from.
    let resolveFirst: (r: SessionTreeResponse) => void = () => {};
    treeMock.mockImplementationOnce(
      () => new Promise<SessionTreeResponse>((res) => (resolveFirst = res)),
    );
    treeMock.mockResolvedValue({ root: node({ id: "sess_root2" }), descendants: [] });

    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | undefined }) => useChatStreamTree(sid),
      { initialProps: { sid: "sess_root" as string | undefined } },
    );
    rerender({ sid: "sess_root2" });
    await waitFor(() => expect(result.current.nodes.sess_root2).toBeDefined());

    await act(async () => {
      resolveFirst({ root: node({ id: "sess_root" }), descendants: [] });
    });
    expect(result.current.nodes.sess_root).toBeUndefined();
  });
});

describe("useChatStreamTree — spawn events", () => {
  async function mounted() {
    const hook = renderHook(() => useChatStreamTree("sess_root"));
    await waitFor(() => expect(hook.result.current.nodes.sess_root).toBeDefined());
    return hook;
  }

  it("attaches a child whose parent is already known", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root"));

    expect(result.current.nodes.sess_child).toMatchObject({
      id: "sess_child",
      parent_session_id: "sess_root",
      agent_id: "agent_ic",
      agent_hierarchy: "ic",
      type: "task",
      status: "pending",
      intent: "do the subtask",
    });
    expect(result.current.children.sess_root).toEqual(["sess_child"]);
  });

  it("drops a spawn whose parent isn't in the tree", async () => {
    // Otherwise every unrelated session on the shared bus accumulates.
    const { result } = await mounted();
    emit(spawnEvent("sess_someone_else"));
    expect(result.current.nodes.sess_child).toBeUndefined();
    expect(Object.keys(result.current.nodes)).toEqual(["sess_root"]);
  });

  it("dedupes a redelivered spawn", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root"));
    emit(spawnEvent("sess_root", { intent: "resent" }));

    expect(result.current.children.sess_root).toEqual(["sess_child"]);
    expect(result.current.nodes.sess_child!.intent).toBe("do the subtask");
  });

  it("derives short ids from the child and task ids", async () => {
    const { result } = await mounted();
    emit(
      spawnEvent("sess_root", {
        child_session_id: "sess_kBpTkqiCbsB3",
        task_id: "task_9zzYYxxWWvv",
      }),
    );
    expect(result.current.nodes.sess_kBpTkqiCbsB3).toMatchObject({
      short_id: "kBpTkq",
      task_short_id: "9zzYYx",
    });
  });

  it("falls back to the raw id when it's too short to slice", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root", { child_session_id: "short", task_id: "t_1" }));
    expect(result.current.nodes.short).toMatchObject({
      short_id: "short",
      task_short_id: null,
    });
  });

  it("nulls the task fields when the spawn carries no task", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root", { task_id: undefined }));
    expect(result.current.nodes.sess_child).toMatchObject({
      task_id: null,
      task_short_id: null,
      task_title: null,
    });
  });

  it("defaults a missing intent to an empty string", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root", { intent: undefined }));
    expect(result.current.nodes.sess_child!.intent).toBe("");
  });

  it("uses the agent id as the placeholder label until /tree refetches", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root", { agent_id: "agent_xyz" }));
    expect(result.current.nodes.sess_child!.agent_label).toBe("agent_xyz");
  });

  it("ignores a spawn missing its child id or agent id", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root", { child_session_id: undefined }));
    emit(spawnEvent("sess_root", { agent_id: undefined }));
    expect(Object.keys(result.current.nodes)).toEqual(["sess_root"]);
  });

  it("attaches a grandchild once its parent has been spawned", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root", { child_session_id: "sess_child" }));
    emit(spawnEvent("sess_child", { child_session_id: "sess_grandchild" }));

    expect(result.current.children.sess_child).toEqual(["sess_grandchild"]);
  });
});

describe("useChatStreamTree — step events", () => {
  async function mounted() {
    const hook = renderHook(() => useChatStreamTree("sess_root"));
    await waitFor(() => expect(hook.result.current.nodes.sess_root).toBeDefined());
    return hook;
  }

  it("keys steps by the session they arrived for", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root"));
    emit(stepEvent("sess_root", { event_id: "evt_root" }));
    emit(stepEvent("sess_child", { event_id: "evt_child" }));

    expect(result.current.steps.sess_root).toHaveLength(1);
    expect(result.current.steps.sess_child).toHaveLength(1);
  });

  it("drops steps for a session outside the tree", async () => {
    const { result } = await mounted();
    emit(stepEvent("sess_unknown"));
    expect(result.current.steps).toEqual({});
  });

  it("dedupes a redelivered step", async () => {
    const { result } = await mounted();
    emit(stepEvent("sess_root", { event_id: "evt_1" }));
    emit(stepEvent("sess_root", { event_id: "evt_1", content: "resent" }));

    expect(result.current.steps.sess_root).toHaveLength(1);
    expect(result.current.steps.sess_root![0]!.content).toBe("ls -la");
  });

  it("appends in arrival order per session", async () => {
    const { result } = await mounted();
    emit(stepEvent("sess_root", { event_id: "evt_1", content: "first" }));
    emit(stepEvent("sess_root", { event_id: "evt_2", content: "second" }));

    expect(result.current.steps.sess_root!.map((s) => s.content)).toEqual([
      "first",
      "second",
    ]);
  });

  it("ignores an unparseable step for a known session", async () => {
    const { result } = await mounted();
    emit(stepEvent("sess_root", { kind: "nope" }));
    expect(result.current.steps).toEqual({});
  });

  it("keeps a spawned child's steps that arrive before the /tree refetch", async () => {
    const { result } = await mounted();
    emit(spawnEvent("sess_root"));
    emit(stepEvent("sess_child", { event_id: "evt_early" }));
    expect(result.current.steps.sess_child).toHaveLength(1);
  });
});
