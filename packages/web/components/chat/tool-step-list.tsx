"use client";

import type { CSSProperties, ReactElement } from "react";
import { AlertCircle, CornerDownRight } from "lucide-react";
import type { ChatStreamStep, ChatStreamTree } from "@/lib/chat-stream";
import { categoryAccent, formatTool } from "@/lib/tool-format";
import { cn } from "@/lib/utils";
import { InlineICTranscript } from "./inline-ic-transcript";
import {
  SessionRecallBlock,
  parseRecallContent,
} from "@/components/recall/session-recall-block";

/**
 * Compact list of streamed tool calls + results for a single agent
 * session — one row per call with a category-colored icon and a short
 * detail line ("Read foo.ts", "Asked another agent"). Used in:
 *
 *   - chat surface's Thinking bubble for the in-flight 1:1 turn
 *   - room view's typing indicators per running session, so audience
 *     sees what each typing agent is doing in real time
 *
 * tool_result rows render as indented follow-ups under their preceding
 * tool_call — errors use a destructive accent so a failing tool no
 * longer looks like a silent success.
 *
 * Older steps are rolled into a "+N earlier moves" line so the list
 * stays scannable.
 *
 * When `tree` + `parentSessionId` are passed, each `create_task`
 * tool_call gets an `<InlineICTranscript>` block rendered below it so
 * the spawned IC's live work shows up nested under the row that
 * delegated to it. The Nth `create_task` step is matched to the Nth
 * child session in `tree.children[parentSessionId]` — tool calls in
 * Claude Code run serially within a turn, so the spawn-order ↔ call-
 * order match holds.
 */
export function ToolStepList({
  steps,
  totalSteps,
  withTopBorder,
  tree,
  parentSessionId,
  depth = 0,
  emphasizeLatest = false,
}: {
  steps: ChatStreamStep[];
  totalSteps: number;
  withTopBorder?: boolean;
  tree?: ChatStreamTree;
  parentSessionId?: string;
  depth?: number;
  /**
   * Live mode: spotlight the newest row (large + bright + a one-shot pop-in)
   * and fade older rows progressively into the back, so attention tracks the
   * step the agent is on right now. Off for static/completed lists.
   */
  emphasizeLatest?: boolean;
}) {
  const childIds =
    tree && parentSessionId ? tree.children[parentSessionId] ?? [] : [];
  let createTaskCallIndex = 0;
  return (
    <ul
      className={cn(
        "space-y-0.5 text-[11px]",
        withTopBorder ? "mt-3 pt-2 border-t border-border/45" : "mt-1.5",
      )}
    >
      {steps.flatMap((step, idx) => {
        const fromEnd = steps.length - 1 - idx;
        const isLatest = fromEnd === 0;
        // Live spotlight: newest row pops + stays full opacity; older rows
        // fade and recede. Off → no extra class/style (flat list).
        const emph = emphasizeLatest ? rowEmphasis(fromEnd) : undefined;
        if (step.kind === "tool_result") {
          // session_search discover results get the rich recall block in
          // place of the lean one-line result row. Falls back to the lean
          // row when the 512-char SSE truncation cut the JSON before any
          // complete hit (parseRecallContent returns null).
          if (step.tool_name === "session_search") {
            const recall = parseRecallContent(step.content);
            if (recall && recall.hits.length > 0) {
              return [
                <li
                  key={step.event_id}
                  className={cn("pl-3 pt-1", emph?.className)}
                  style={emph?.style}
                >
                  <SessionRecallBlock result={recall} maxHits={1} dense />
                </li>,
              ];
            }
          }
          return [
            <ResultRow
              key={step.event_id}
              step={step}
              isLatest={isLatest}
              className={emph?.className}
              style={emph?.style}
            />,
          ];
        }
        const isCreateTask =
          step.kind === "tool_call" && step.tool_name === "create_task";
        const inlineChildId =
          isCreateTask && tree
            ? childIds[createTaskCallIndex++]
            : undefined;
        const rows: ReactElement[] = [
          <CallRow
            key={step.event_id}
            step={step}
            isLatest={isLatest}
            className={emph?.className}
            style={emph?.style}
          />,
        ];
        if (inlineChildId) {
          // <li> wrapper keeps the <ul> children list valid; the
          // InlineICTranscript itself owns its indentation + border-l
          // so there's no extra row chrome.
          rows.push(
            <li key={`${step.event_id}-child`}>
              <InlineICTranscript
                sessionId={inlineChildId}
                tree={tree!}
                depth={depth + 1}
              />
            </li>,
          );
        }
        return rows;
      })}
      {totalSteps > steps.length ? (
        <li className="text-[10px] text-muted-foreground/50 pl-5 pt-0.5">
          + {totalSteps - steps.length} earlier move{totalSteps - steps.length === 1 ? "" : "s"}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Live-spotlight styling for a row by its distance from the newest step.
 * Newest (`fromEnd === 0`) pops big + bright; older rows fade toward a 0.4
 * floor and recede. `transition` makes a row demote smoothly when the next
 * step arrives; `origin-left` keeps the scale anchored to the row start.
 */
function rowEmphasis(fromEnd: number): { className: string; style: CSSProperties } {
  return {
    className: cn(
      "transition-[opacity,transform] duration-300 origin-left",
      fromEnd === 0 && "font-medium scale-[1.03] animate-step-pop",
    ),
    style: { opacity: Math.max(0.4, 1 - fromEnd * 0.22) },
  };
}

function CallRow({
  step,
  isLatest,
  className,
  style,
}: {
  step: ChatStreamStep;
  isLatest: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const display = formatTool(step.tool_name, step.content);
  return (
    <li className={cn("flex items-center gap-1.5 text-muted-foreground/80", className)} style={style}>
      <span
        className={cn(
          "shrink-0 inline-flex items-center justify-center h-4 w-4 rounded opacity-70",
          categoryAccent(display.category),
          isLatest && "opacity-100",
        )}
      >
        <display.icon className="h-2.5 w-2.5" />
      </span>
      <div className="flex-1 min-w-0 leading-4">
        <div className="flex items-baseline gap-1.5">
          <span className="text-foreground/70 shrink-0">{display.label}</span>
          {display.detail ? (
            <span className="text-muted-foreground/60 truncate min-w-0">{display.detail}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function ResultRow({
  step,
  isLatest,
  className,
  style,
}: {
  step: ChatStreamStep;
  isLatest: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  // `[error] ` prefix comes from the runtime adapter when the tool
  // reported `is_error: true`; strip it before display.
  const isError = step.content.startsWith("[error] ");
  const text = isError ? step.content.slice("[error] ".length) : step.content;
  const Icon = isError ? AlertCircle : CornerDownRight;
  return (
    <li className={cn("flex items-center gap-1.5 pl-3", className)} style={style}>
      <span
        className={cn(
          "shrink-0 inline-flex items-center justify-center h-4 w-4",
          isError ? "text-destructive" : "text-muted-foreground/40",
          isLatest && "text-muted-foreground/70",
        )}
      >
        <Icon className="h-2.5 w-2.5" />
      </span>
      <div className="flex-1 min-w-0 leading-4">
        <span
          className={cn(
            "truncate min-w-0 block",
            isError ? "text-destructive/90" : "text-muted-foreground/50",
          )}
        >
          {text || (isError ? "tool error" : "result")}
        </span>
      </div>
    </li>
  );
}
