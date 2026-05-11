"use client";

import type { ChatStreamStep } from "@/lib/chat-stream";
import { categoryAccent, formatTool } from "@/lib/tool-format";
import { cn } from "@/lib/utils";

/**
 * Compact list of streamed tool calls for a single agent session —
 * one row per call with a category-colored icon and a short detail
 * line ("Read foo.ts", "Asked another agent"). Used in:
 *
 *   - chat surface's Thinking bubble for the in-flight 1:1 turn
 *   - room view's typing indicators per running session, so audience
 *     sees what each typing agent is doing in real time
 *
 * The latest step pulses to draw the eye to "now". Older steps are
 * rolled into a "+N earlier steps" line so the list stays scannable.
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
        "space-y-1 text-[11px]",
        withTopBorder ? "mt-2 pt-2 border-t border-border/60" : "mt-1",
      )}
    >
      {steps.map((step, idx) => {
        const display = formatTool(step.tool_name, step.content);
        const isLatest = idx === steps.length - 1;
        return (
          <li key={step.event_id} className="flex items-start gap-1.5">
            <span
              className={cn(
                "shrink-0 inline-flex items-center justify-center h-4 w-4 rounded",
                categoryAccent(display.category),
                isLatest && "animate-pulse-breathe",
              )}
            >
              <display.icon className="h-2.5 w-2.5" />
            </span>
            <div className="flex-1 min-w-0 leading-tight">
              <div className="flex items-baseline gap-1.5">
                <span className="font-medium text-foreground/85 shrink-0">{display.label}</span>
                {display.detail ? (
                  <span className="text-muted-foreground truncate min-w-0">
                    {display.detail}
                  </span>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
      {totalSteps > steps.length ? (
        <li className="text-[10px] text-muted-foreground/70 pl-5">
          + {totalSteps - steps.length} earlier step{totalSteps - steps.length === 1 ? "" : "s"}
        </li>
      ) : null}
    </ul>
  );
}
