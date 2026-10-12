import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The metadata strip every detail page closes with: a responsive grid of
 * {@link FooterField}s under a hairline rule.
 *
 * All seven detail pages (agent, task, session, chat session, work product,
 * negotiation, escalation) ended their body with a byte-identical
 * `<footer className="mt-10 pt-5 border-t …">` wrapping nothing but
 * `FooterField` children. `FooterField` itself was already shared — only the
 * container had been left inline, so the grid breakpoints and the rule were
 * seven copies of one decision. Changing the layout meant editing all seven
 * and hoping none was missed.
 *
 * The children stay per-page: which fields a detail page shows, and in what
 * order, is the one part that genuinely differs.
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
