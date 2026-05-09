"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Chat markdown renderer.
 *
 * The agent emits GitHub-flavored markdown — tables, fenced code, task
 * lists, autolinks. We render it inline inside the bubble. Styling is
 * tuned for the small bubble surface: tight line-height, no oversized
 * headings, code blocks that don't blow out the column width.
 *
 * `inverted` flips the link / code colors for the user's primary-bg
 * bubble (text already inherits primary-foreground).
 */
export function ChatMarkdown({
  content,
  inverted,
  className,
}: {
  content: string;
  inverted?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "chat-md text-sm leading-relaxed",
        inverted ? "chat-md-inverted" : undefined,
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
