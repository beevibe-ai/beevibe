import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The metadata strip at the bottom of a detail page — a responsive grid
 * of {@link FooterField}s.
 *
 * All seven detail clients (agent, task, session, chat session, work
 * product, negotiation, escalation) had the same nine-class `<footer>`
 * written out by hand. The fields inside differ per resource, but the
 * strip itself is one piece of page furniture, and a hand-copied class
 * string is how one page ends up a column wider than the rest.
 */
export function DetailFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
      {children}
    </footer>
  );
}

export function FooterField({
  label,
  children,
  truncate,
}: {
  label: string;
  children: ReactNode;
  truncate?: boolean;
}) {
  return (
    <div className={cn(truncate && "min-w-0")}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
        {label}
      </div>
      <div className={cn("text-foreground/80", truncate && "truncate")}>{children}</div>
    </div>
  );
}
