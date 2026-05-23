"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import type { ChatStreamTree } from "@/lib/chat-stream";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { cn } from "@/lib/utils";
import { ToolStepList } from "./tool-step-list";

/**
 * Collapsible inline block rendering an IC specialist's live transcript
 * directly under the team agent's `create_task` row that spawned it.
 *
 * Removes the need to navigate Tasks → Task → Session to watch a
 * delegated specialist's work. The block hydrates from the chat-stream
 * tree (which subscribes to both `session.step` and `session.spawned`
 * SSE events) so the IC's tool calls and results appear live.
 *
 * Depth is capped at 2 inline; depth-3+ shows a "View nested session →"
 * link to the dedicated session detail page so the chat doesn't grow
 * uncontrolled vertical nesting. In practice this cap is mostly
 * defensive — IC agents don't currently receive the `create_task` tool
 * (only team agents do per assemble.ts buildHierarchyTools wiring),
 * so team→IC→IC chains aren't structurally possible today.
 */
const MAX_INLINE_DEPTH = 2;
const PREVIEW_STEPS = 12;

export function InlineICTranscript({
  sessionId,
  tree,
  depth = 1,
}: {
  sessionId: string;
  tree: ChatStreamTree;
  depth?: number;
}) {
  const node = tree.nodes[sessionId];
  const steps = tree.steps[sessionId] ?? [];
  const [expanded, setExpanded] = useState(true);
  if (!node) return null;

  if (depth > MAX_INLINE_DEPTH) {
    return (
      <div className="mt-1 ml-6 pl-3 border-l border-border/40">
        <Link
          href={`/tasks/${encodeURIComponent(node.task_id ?? "")}/sessions/${encodeURIComponent(node.short_id)}`}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          View nested session: <span className="font-mono">{node.agent_label}</span>
        </Link>
      </div>
    );
  }

  const Chevron = expanded ? ChevronDown : ChevronRight;
  const recentSteps = steps.slice(-PREVIEW_STEPS);
  const statusDot = node.completed_at
    ? "bg-muted-foreground/40"
    : node.status === "failed"
      ? "bg-destructive"
      : "bg-emerald-500 animate-pulse";

  const sessionHref =
    node.task_id && node.task_short_id
      ? `/tasks/${encodeURIComponent(node.task_id)}/sessions/${encodeURIComponent(node.short_id)}`
      : null;

  return (
    <div
      className={cn(
        "mt-2 ml-6 pl-3 border-l border-border/50",
        depth > 1 && "ml-3 pl-2 border-border/30",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        aria-expanded={expanded}
      >
        <Chevron className="h-3 w-3 shrink-0" />
        <Avatar
          initial={(node.agent_label || "?").charAt(0).toUpperCase()}
          kind={node.agent_hierarchy}
          label={node.agent_label}
          size={18}
        />
        <span className="font-medium text-foreground/85 truncate">{node.agent_label}</span>
        <HierChip hier={node.agent_hierarchy} />
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", statusDot)} />
        <span className="text-muted-foreground/70 shrink-0">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
        {node.intent ? (
          <span className="ml-1 truncate text-muted-foreground/60 min-w-0">
            · {node.intent}
          </span>
        ) : null}
        {sessionHref ? (
          <Link
            href={sessionHref}
            onClick={(e) => e.stopPropagation()}
            className="ml-auto shrink-0 text-muted-foreground/60 hover:text-foreground"
            title="Open full session"
          >
            <ExternalLink className="h-3 w-3" />
          </Link>
        ) : null}
      </button>

      {expanded ? (
        recentSteps.length > 0 ? (
          <ToolStepList
            steps={recentSteps}
            totalSteps={steps.length}
            tree={tree}
            parentSessionId={sessionId}
            depth={depth}
          />
        ) : (
          <div className="mt-1 ml-5 text-[11px] text-muted-foreground/60">
            {node.status === "pending" ? "Spawning…" : "Waiting for first step…"}
          </div>
        )
      ) : null}
    </div>
  );
}
