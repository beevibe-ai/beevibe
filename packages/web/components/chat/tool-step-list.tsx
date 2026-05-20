"use client";

import { AlertCircle, CornerDownRight } from "lucide-react";
import type { ChatStreamStep } from "@/lib/chat-stream";
import { categoryAccent, formatTool } from "@/lib/tool-format";
import { cn } from "@/lib/utils";

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
 */
export function ToolStepList({
  steps,
  totalSteps,
  withTopBorder,
}: {
  steps: ChatStreamStep[];
  totalSteps: number;
  withTopBorder?: boolean;
}) {
  return (
    <ul
      className={cn(
        "space-y-0.5 text-[11px]",
        withTopBorder ? "mt-3 pt-2 border-t border-border/45" : "mt-1.5",
      )}
    >
      {steps.map((step, idx) => {
        const isLatest = idx === steps.length - 1;
        if (step.kind === "tool_result") {
          return <ResultRow key={step.event_id} step={step} isLatest={isLatest} />;
        }
        return <CallRow key={step.event_id} step={step} isLatest={isLatest} />;
      })}
      {totalSteps > steps.length ? (
        <li className="text-[10px] text-muted-foreground/50 pl-5 pt-0.5">
          + {totalSteps - steps.length} earlier move{totalSteps - steps.length === 1 ? "" : "s"}
        </li>
      ) : null}
    </ul>
  );
}

function CallRow({ step, isLatest }: { step: ChatStreamStep; isLatest: boolean }) {
  const display = formatTool(step.tool_name, step.content);
  return (
    <li className="flex items-center gap-1.5 text-muted-foreground/80">
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

function ResultRow({ step, isLatest }: { step: ChatStreamStep; isLatest: boolean }) {
  // `[error] ` prefix comes from the runtime adapter when the tool
  // reported `is_error: true`; strip it before display.
  const isError = step.content.startsWith("[error] ");
  const text = isError ? step.content.slice("[error] ".length) : step.content;
  const Icon = isError ? AlertCircle : CornerDownRight;
  return (
    <li className="flex items-center gap-1.5 pl-3">
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
