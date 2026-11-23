"use client";

import { useState } from "react";
import { ChatMarkdown } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";

/**
 * Markdown body that collapses to a character budget with a "Show more"
 * affordance.
 *
 * `core-block-card`'s `ProseBlock` and `task-detail-panel`'s
 * `DescriptionSection` had both spelled this out: the same
 * `useState(!long)` seed (so short content is never collapsed and never
 * shows the button), the same `slice(0, threshold).trimEnd() + "…"`, and
 * the same button markup down to the class list. Only the threshold and
 * the wrapper's text class differed, so those are the props.
 *
 * Expanding is deliberately one-way — neither call site offered a "Show
 * less", and adding one here would change both surfaces.
 */
export function CollapsibleMarkdown({
  content,
  threshold,
  className,
}: {
  content: string;
  /** Character budget before the body is truncated. */
  threshold: number;
  /** Applied to the markdown wrapper — the two call sites size text differently. */
  className?: string;
}) {
  const long = content.length > threshold;
  const [expanded, setExpanded] = useState(!long);
  const visible =
    long && !expanded ? content.slice(0, threshold).trimEnd() + "…" : content;

  return (
    <>
      <div className={cn("text-foreground/85", className)}>
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
