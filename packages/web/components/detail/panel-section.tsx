import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A titled block inside a peek panel: small uppercase heading, an optional
 * count beside it, and either the children or an italic empty line.
 *
 * The agent peek and the task peek each had their own copy of this. They had
 * drifted — different top margin, different heading opacity, and the agent's
 * required a `count` where the task's made it optional — so unifying picks
 * the task panel's version, which is the functional superset. The two panels
 * are the same surface over different data (see `PeekPanel`), so they should
 * not be a few pixels apart.
 */
export function PanelSection({
  title,
  count,
  empty,
  tone,
  children,
}: {
  title: string;
  /** Omit to render no count at all. `0` renders the count and the `empty` line. */
  count?: number;
  empty?: string;
  /** `blocked` tints the whole block — used for a task's blocker callout. */
  tone?: "blocked";
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "mt-5",
        tone === "blocked" &&
          "rounded-md border border-status-blocked/40 bg-status-blocked/5 p-3 -mx-1",
      )}
    >
      <h3
        className={cn(
          "text-[10px] uppercase tracking-wider mb-2 font-semibold",
          tone === "blocked" ? "text-status-blocked" : "text-muted-foreground/85",
        )}
      >
        {title}
        {count !== undefined ? (
          <span className="ml-1 text-muted-foreground/70 tabular-nums font-normal">
            {count}
          </span>
        ) : null}
      </h3>
      {count === 0 && empty ? (
        <p className="text-xs text-muted-foreground italic">{empty}</p>
      ) : (
        children
      )}
    </section>
  );
}
