import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { BvEvent } from "./sse";
import type { SessionTreeNode, SessionTreeResponse } from "./types/sessions";

// Capture the callback each hook instance registers with useSseEvents so the
// tests can drive raw SSE events by hand. The real hook subscribes to a
// shared EventSource; here we just record the latest listener.
let sseListener: ((ev: BvEvent) => void) | undefined;
vi.mock("./sse", () => ({
  useSseEvents: (cb: (ev: BvEvent) => void) => {
    sseListener = cb;
  },
}));

vi.mock("./api/client", () => ({
  api: { sessions: { tree: vi.fn() } },
}));

import { useChatStream, useChatStreamTree } from "./chat-stream";
import { api } from "./api/client";

const treeMock = vi.mocked(api.sessions.tree);

function emit(ev: BvEvent) {
  act(() => {
    sseListener?.(ev);
  });
}

function step(id: string, data: Record<string, unknown>): BvEvent {
  return { event: "session.step", id, data };
}

beforeEach(() => {
  sseListener = undefined;
  treeMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useChatStream", () => {
  it("returns an empty step list when no session id is subscribed", () => {
    const { result } = renderHook(() => useChatStream(undefined));
    expect(result.current.steps).toEqual([]);
    expect(result.current.stepsBySession).toEqual({});
  });

  it("accumulates steps for the subscribed session in arrival order", () => {
    const { result } = renderHook(() => useChatStream("sess_1"));

    emit(step("sess_1", { kind: "tool_call", event_id: "e1", tool_name: "Bash", content: "ls" }));
    emit(step("sess_1", { kind: "tool_result", event_id: "e2", content: "done" }));

    expect(result.current.steps.map((s) => s.event_id)).toEqual(["e1", "e2"]);
    expect(result.current.steps[0]).toMatchObject({
      kind: "tool_call",
      tool_name: "Bash",
      content: "ls",
    });
    expect(result.current.stepsBySession["sess_1"]).toHaveLength(2);
  });

  it("ignores events addressed to a different session id", () => {
    const { result } = renderHook(() => useChatStream("sess_1"));
    emit(step("sess_other", { kind: "agent", event_id: "x", content: "nope" }));
    expect(result.current.steps).toEqual([]);
  });

  it("dedups repeated event_ids", () => {
    const { result } = renderHook(() => useChatStream("sess_1"));
    emit(step("sess_1", { kind: "summary", event_id: "dup", content: "one" }));
    emit(step("sess_1", { kind: "summary", event_id: "dup", content: "one-again" }));
    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0].content).toBe("one");
  });

  it("drops non-step events and unknown step kinds", () => {
    const { result } = renderHook(() => useChatStream("sess_1"));
    emit({ event: "task.updated", id: "sess_1" });
    emit(step("sess_1", { kind: "banana", event_id: "e", content: "x" }));
    emit(step("sess_1", { event_id: "e2", content: "no-kind" }));
    expect(result.current.steps).toEqual([]);
  });

  it("defaults missing tool_name/content and coerces non-string fields", () => {
    const { result } = renderHook(() => useChatStream("sess_1"));
    emit(step("sess_1", { kind: "agent", event_id: "e1", tool_name: 42, content: null }));
    expect(result.current.steps[0]).toMatchObject({ tool_name: undefined, content: "" });
  });
});

// ── Tree variant ────────────────────────────────────────────────────────────

function node(overrides: Partial<SessionTreeNode> & { id: string }): SessionTreeNode {
  return {
    short_id: overrides.id.slice(5, 11),
    parent_session_id: null,
    agent_id: "agent_x",
    agent_label: "Agent X",
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
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useChatStreamTree", () => {
  it("stays empty and skips the fetch when there is no root", () => {
    const { result } = renderHook(() => useChatStreamTree(undefined));
    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
    expect(treeMock).not.toHaveBeenCalled();
  });

  it("hydrates nodes and children from the /tree snapshot", async () => {
    const root = node({ id: "sess_rootAAA" });
    const child = node({ id: "sess_childBBB", parent_session_id: "sess_rootAAA" });
    treeMock.mockResolvedValue({ root, descendants: [child] } satisfies SessionTreeResponse);

    const { result } = renderHook(() => useChatStreamTree("sess_rootAAA"));

    await waitFor(() => expect(result.current.nodes["sess_rootAAA"]).toBeDefined());
    expect(result.current.nodes["sess_childBBB"]).toBeDefined();
    expect(result.current.children["sess_rootAAA"]).toEqual(["sess_childBBB"]);
    expect(treeMock).toHaveBeenCalledWith("sess_rootAAA");
  });

  it("survives a /tree fetch failure and still ingests live spawns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    treeMock.mockRejectedValue(new Error("cold mount failed"));

    const { result } = renderHook(() => useChatStreamTree("sess_rootAAA"));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    // No root node was hydrated, so an unrelated spawn is dropped.
    emit({
      event: "session.spawned",
      id: "sess_rootAAA",
      data: { child_session_id: "sess_kidCCC", agent_id: "agent_k" },
    });
    expect(result.current.nodes).toEqual({});
    warn.mockRestore();
  });

  it("attaches a live spawn whose parent is already in the tree", async () => {
    treeMock.mockResolvedValue({
      root: node({ id: "sess_rootAAA" }),
      descendants: [],
    });
    const { result } = renderHook(() => useChatStreamTree("sess_rootAAA"));
    await waitFor(() => expect(result.current.nodes["sess_rootAAA"]).toBeDefined());

    emit({
      event: "session.spawned",
      id: "sess_rootAAA",
      data: {
        child_session_id: "sess_kidCCCDDD",
        agent_id: "agent_k",
        task_id: "task_tttUUUvvv",
        intent: "do the thing",
      },
    });

    const kid = result.current.nodes["sess_kidCCCDDD"];
    expect(kid).toBeDefined();
    expect(kid.parent_session_id).toBe("sess_rootAAA");
    expect(kid.agent_id).toBe("agent_k");
    expect(kid.task_id).toBe("task_tttUUUvvv");
    expect(kid.task_short_id).toBe("tttUUU");
    expect(kid.intent).toBe("do the thing");
    expect(kid.short_id).toBe("kidCCC");
    expect(result.current.children["sess_rootAAA"]).toContain("sess_kidCCCDDD");
  });

  it("ignores a spawn whose parent is not yet known", async () => {
    treeMock.mockResolvedValue({ root: node({ id: "sess_rootAAA" }), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootAAA"));
    await waitFor(() => expect(result.current.nodes["sess_rootAAA"]).toBeDefined());

    emit({
      event: "session.spawned",
      id: "sess_unknownZZZ",
      data: { child_session_id: "sess_orphan", agent_id: "agent_o" },
    });
    expect(result.current.nodes["sess_orphan"]).toBeUndefined();
  });

  it("dedups a spawn that is already present", async () => {
    treeMock.mockResolvedValue({ root: node({ id: "sess_rootAAA" }), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootAAA"));
    await waitFor(() => expect(result.current.nodes["sess_rootAAA"]).toBeDefined());

    const spawn: BvEvent = {
      event: "session.spawned",
      id: "sess_rootAAA",
      data: { child_session_id: "sess_kidCCC", agent_id: "agent_k" },
    };
    emit(spawn);
    emit(spawn);
    expect(result.current.children["sess_rootAAA"]).toEqual(["sess_kidCCC"]);
  });

  it("ignores malformed spawn payloads (missing child or agent id)", async () => {
    treeMock.mockResolvedValue({ root: node({ id: "sess_rootAAA" }), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootAAA"));
    await waitFor(() => expect(result.current.nodes["sess_rootAAA"]).toBeDefined());

    emit({ event: "session.spawned", id: "sess_rootAAA", data: { agent_id: "agent_k" } });
    emit({ event: "session.spawned", id: "sess_rootAAA", data: { child_session_id: "sess_x" } });
    expect(Object.keys(result.current.nodes)).toEqual(["sess_rootAAA"]);
  });

  it("accumulates steps only for nodes already in the tree", async () => {
    treeMock.mockResolvedValue({ root: node({ id: "sess_rootAAA" }), descendants: [] });
    const { result } = renderHook(() => useChatStreamTree("sess_rootAAA"));
    await waitFor(() => expect(result.current.nodes["sess_rootAAA"]).toBeDefined());

    emit(step("sess_rootAAA", { kind: "tool_call", event_id: "s1", content: "run" }));
    // Step for an unknown session is dropped.
    emit(step("sess_ghost", { kind: "tool_call", event_id: "s2", content: "drop" }));
    // Duplicate is deduped.
    emit(step("sess_rootAAA", { kind: "tool_call", event_id: "s1", content: "run" }));

    expect(result.current.steps["sess_rootAAA"]).toHaveLength(1);
    expect(result.current.steps["sess_ghost"]).toBeUndefined();
  });

  it("does not apply a stale /tree response after the root changes", async () => {
    const first = deferred<SessionTreeResponse>();
    treeMock.mockReturnValueOnce(first.promise);
    treeMock.mockResolvedValueOnce({ root: node({ id: "sess_second" }), descendants: [] });

    const { result, rerender } = renderHook(({ root }) => useChatStreamTree(root), {
      initialProps: { root: "sess_first" },
    });

    // Switch roots before the first fetch resolves; its cancelled closure
    // must not write the first root's node into the (now second) tree.
    rerender({ root: "sess_second" });
    await waitFor(() => expect(result.current.nodes["sess_second"]).toBeDefined());

    await act(async () => {
      first.resolve({ root: node({ id: "sess_first" }), descendants: [] });
      await first.promise;
    });

    expect(result.current.nodes["sess_first"]).toBeUndefined();
  });

  it("resets to empty when the root becomes undefined", async () => {
    treeMock.mockResolvedValue({ root: node({ id: "sess_rootAAA" }), descendants: [] });
    const { result, rerender } = renderHook(
      ({ root }: { root: string | undefined }) => useChatStreamTree(root),
      { initialProps: { root: "sess_rootAAA" as string | undefined } },
    );
    await waitFor(() => expect(result.current.nodes["sess_rootAAA"]).toBeDefined());

    rerender({ root: undefined });
    expect(result.current).toEqual({ nodes: {}, children: {}, steps: {} });
  });
});
