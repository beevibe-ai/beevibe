"use client";

import { useState } from "react";
import { ChatMarkdown } from "@/components/chat/markdown";

/**
 * Markdown prose that collapses to a preview with a "Show more" button
 * when it exceeds `threshold` characters.
 *
 * Two copies of this existed — `ProseBlock` in `agents/core-block-card`
 * (threshold 400) and `DescriptionSection` in `tasks/task-detail-panel`
 * (threshold 500) — down to the same `slice(0, n).trimEnd() + "…"`
 * preview, the same `useState(!long)` seed, and the same button classes.
 * Only the threshold and the prose wrapper's text size differed, so both
 * are props.
 *
 * The expanded flag is seeded once per mount and there is no "Show less":
 * the preview is a first-paint concern, and once a reader has opened a
 * block, re-collapsing it under them is worse than a long page. That is
 * the behaviour both copies had.
 */
export function CollapsibleMarkdown({
  content,
  threshold,
  className = "text-foreground/85",
}: {
  content: string;
  /** Preview cutoff in characters; longer content starts collapsed. */
  threshold: number;
  /** Classes for the prose wrapper. */
  className?: string;
}) {
  const long = content.length > threshold;
  const [expanded, setExpanded] = useState(!long);
  const visible =
    long && !expanded ? content.slice(0, threshold).trimEnd() + "…" : content;

  return (
    <>
      <div className={className}>
        <ChatMarkdown content={visible} />
      </div>
      {long && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          Show more
        </button>
      ) : null}
    </>
  );
}
