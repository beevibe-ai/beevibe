"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSseEvents, type BvEvent } from "./sse";
import { api } from "./api/client";
import type { SessionTreeNode } from "./types/sessions";

export interface ChatStreamStep {
  event_id: string;
  kind: "tool_call" | "tool_result" | "agent" | "summary";
  tool_name?: string;
  /** Server truncates to 512 chars in the trigger payload. */
  content: string;
  received_at: number;
}

function parseStep(ev: BvEvent): ChatStreamStep | undefined {
  if (ev.event !== "session.step" || !ev.data) return undefined;
  const d = ev.data;
  const kind = typeof d.kind === "string" ? d.kind : undefined;
  if (kind !== "tool_call" && kind !== "tool_result" && kind !== "agent" && kind !== "summary") {
    return undefined;
  }
  return {
    event_id: typeof d.event_id === "string" ? d.event_id : `${ev.id}-${Date.now()}`,
    kind,
    tool_name: typeof d.tool_name === "string" ? d.tool_name : undefined,
    content: typeof d.content === "string" ? d.content : "",
    received_at: Date.now(),
  };
}

/**
 * Stream of `session.step` events scoped to one session id. Returns the
 * accumulated step list (new chat turn → fresh array, since the new
 * sessionId triggers a new state slot via React's per-render closure).
 */
export function useChatStream(sessionId: string | undefined): ChatStreamStep[] {
  // Keying state by sessionId means each turn gets its own fresh `steps`
  // array — no separate reset effect to race with the resubscription.
  const [stepsBySession, setStepsBySession] = useState<Record<string, ChatStreamStep[]>>({});

  const onEvent = useCallback(
    (ev: BvEvent) => {
      if (!sessionId || ev.id !== sessionId) return;
      const step = parseStep(ev);
      if (!step) return;
      setStepsBySession((prev) => {
        const cur = prev[sessionId] ?? [];
        if (cur.some((s) => s.event_id === step.event_id)) return prev;
        return { ...prev, [sessionId]: [...cur, step] };
      });
    },
    [sessionId],
  );
  useSseEvents(onEvent);

  return sessionId ? stepsBySession[sessionId] ?? EMPTY : EMPTY;
}

const EMPTY: ChatStreamStep[] = [];

// ── Multi-session tree variant ─────────────────────────────────────────────
//
// When a team agent calls `create_task` it spawns an IC session whose
// `parent_session_id` points at the team session. The DB trigger
// `trg_session_spawned_notify` emits a `session.spawned` event keyed on the
// PARENT id with the CHILD id in the payload, so we can extend the team
// session's chat stream to also cover its descendants.
//
// `useChatStreamTree(rootSessionId)` returns three maps keyed by full
// session id:
//   - `nodes`   : SessionTreeNode metadata (from the cold-mount /tree fetch
//                 plus inline data on every spawn event)
//   - `children`: parent → child[] adjacency, derived from `nodes`
//   - `steps`   : per-session ChatStreamStep[] accumulated from
//                 `session.step` events for every node we know about
//
// On root change or first mount, we fetch `/session/:id/tree` to hydrate
// the structural snapshot. SSE then fills in new spawns + steps live.

export interface ChatStreamTree {
  /** Every session in the tree, keyed by full id. Includes the root. */
  nodes: Record<string, SessionTreeNode>;
  /** Parent id → ordered list of child ids. Roots and leaves both possible. */
  children: Record<string, string[]>;
  /** Per-session live step list, only populated as SSE delivers steps. */
  steps: Record<string, ChatStreamStep[]>;
}

const EMPTY_TREE: ChatStreamTree = { nodes: {}, children: {}, steps: {} };

function parseSpawn(ev: BvEvent): SessionTreeNode | undefined {
  if (ev.event !== "session.spawned" || !ev.data) return undefined;
  const d = ev.data;
  const childId = typeof d.child_session_id === "string" ? d.child_session_id : undefined;
  const agentId = typeof d.agent_id === "string" ? d.agent_id : undefined;
  if (!childId || !agentId) return undefined;
  return {
    id: childId,
    short_id: childId.length >= 11 ? childId.slice(5, 11) : childId,
    parent_session_id: ev.id,
    agent_id: agentId,
    // Spawn event payload doesn't carry the agent label / hierarchy — fill
    // with placeholders that the next /tree refetch (triggered by the
    // session.spawned invalidation) will replace.
    agent_label: agentId,
    agent_hierarchy: "ic",
    task_id: typeof d.task_id === "string" ? d.task_id : null,
    task_short_id:
      typeof d.task_id === "string" && d.task_id.length >= 11
        ? d.task_id.slice(5, 11)
        : null,
    task_title: null,
    type: "task",
    status: "pending",
    intent: typeof d.intent === "string" ? d.intent : "",
    started_at: null,
    completed_at: null,
  };
}

export function useChatStreamTree(rootSessionId: string | undefined): ChatStreamTree {
  const [tree, setTree] = useState<ChatStreamTree>(EMPTY_TREE);

  // Hydrate on root change. The /tree fetch may race with the SSE stream
  // (events can arrive before the HTTP response); the merge below is
  // idempotent and uses spawn-event placeholders only when no /tree node
  // exists yet, so events either way converge on the same shape.
  useEffect(() => {
    if (!rootSessionId) {
      setTree(EMPTY_TREE);
      return;
    }
    let cancelled = false;
    api.sessions
      .tree(rootSessionId)
      .then((res) => {
        if (cancelled) return;
        setTree((prev) => {
          const nodes: Record<string, SessionTreeNode> = { ...prev.nodes };
          nodes[res.root.id] = res.root;
          for (const node of res.descendants) {
            // Don't clobber a richer existing node with the same id (no-op
            // here since /tree is authoritative, but defensive for future).
            nodes[node.id] = node;
          }
          return { ...prev, nodes, children: buildChildren(nodes) };
        });
      })
      .catch(() => {
        // Cold-mount fetch failure is non-fatal — the SSE stream still
        // populates the tree as spawn events arrive. Surface in console
        // for dev debugging.
        if (!cancelled) {
          console.warn("[chat-stream] /session/%s/tree fetch failed", rootSessionId);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rootSessionId]);

  const onEvent = useCallback(
    (ev: BvEvent) => {
      if (!rootSessionId) return;
      const spawn = parseSpawn(ev);
      if (spawn) {
        // Only attach spawns whose parent is already in the tree — otherwise
        // we'd accumulate unrelated sessions from elsewhere on the same
        // SSE bus.
        setTree((prev) => {
          if (!prev.nodes[ev.id]) return prev;
          if (prev.nodes[spawn.id]) return prev; // dedup
          const nodes = { ...prev.nodes, [spawn.id]: spawn };
          return { ...prev, nodes, children: buildChildren(nodes) };
        });
        return;
      }
      const step = parseStep(ev);
      if (!step) return;
      setTree((prev) => {
        if (!prev.nodes[ev.id]) return prev;
        const cur = prev.steps[ev.id] ?? [];
        if (cur.some((s) => s.event_id === step.event_id)) return prev;
        return {
          ...prev,
          steps: { ...prev.steps, [ev.id]: [...cur, step] },
        };
      });
    },
    [rootSessionId],
  );
  useSseEvents(onEvent);

  return useMemo(() => tree, [tree]);
}

function buildChildren(
  nodes: Record<string, SessionTreeNode>,
): Record<string, string[]> {
  const children: Record<string, string[]> = {};
  for (const node of Object.values(nodes)) {
    const parent = node.parent_session_id;
    if (!parent) continue;
    if (!children[parent]) children[parent] = [];
    children[parent].push(node.id);
  }
  return children;
}
