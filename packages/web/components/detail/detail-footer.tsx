import type { ReactNode } from "react";

/**
 * The metadata strip every detail page closes with — a responsive grid of
 * {@link FooterField}s above a hairline rule.
 *
 * All seven detail pages (task, agent, session, chat session, work product,
 * escalation, negotiation) had spelled the same nine-class `<footer>` out by
 * hand. The *fields* differ per page and stay at the call site; only the
 * container is shared, so a spacing or column-count change lands everywhere
 * instead of in whichever six pages someone remembered to update.
 */
export function DetailFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
      {children}
    </footer>
  );
}
