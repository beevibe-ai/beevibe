import type { RecentSession } from "@beevibe/api/views/types";

/**
 * Shared styling for the agent detail page's recent-activity rows —
 * `RecentSessionRow` (task/mesh/blocker) and `RecentChatThreadRow` (chat
 * conversations). The two lists are deliberate siblings; keeping the dot
 * map + variant styles here is what makes them read alike.
 */

/** Status union shared by both rows (RecentChatThread.last_status matches). */
export type RecentRowStatus = RecentSession["status"];

/**
 * Status → dot color/animation. `running` gets the breathing pulse to read
 * as live; `review` uses the review accent; everything else (`succeeded`)
 * lands on the muted "done" green.
 */
export const RECENT_ROW_DOT: Record<RecentRowStatus, string> = {
  running: "bg-status-running animate-pulse-breathe",
  review: "bg-status-review",
  succeeded: "bg-status-done",
};

/**
 * `compact` — peek panel (right rail): tighter padding, smaller meta text,
 *   lighter background to fit the panel's nested context.
 * `comfortable` — full agent detail page: roomier padding, base text, solid
 *   card background.
 */
export type RecentRowVariant = "compact" | "comfortable";

export const RECENT_ROW_VARIANT_STYLES: Record<
  RecentRowVariant,
  { row: string; meta: string }
> = {
  compact: {
    row: "flex items-center gap-2 rounded-md border border-border/70 bg-background/40 px-2.5 py-1.5 text-xs",
    meta: "text-[10px]",
  },
  comfortable: {
    row: "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm",
    meta: "text-xs",
  },
};

export const RECENT_ROW_LINKED_HOVER =
  "hover:bg-secondary/50 hover:border-border/80 transition-colors cursor-pointer";
