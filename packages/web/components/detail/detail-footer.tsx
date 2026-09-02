import type { ReactNode } from "react";

/**
 * The metadata strip every detail page closes with — id, related links,
 * type, timestamps — laid out as a 2-up grid that widens to 4-up.
 *
 * All seven detail pages (task, agent, work product, escalation,
 * negotiation, and both session views) opened their footer with the same
 * eleven Tailwind classes copied verbatim. Nothing distinguished them, so
 * the only thing seven copies bought was seven chances for the spacing or
 * the rule above it to drift.
 *
 * Contents stay per-page: what belongs in the strip is genuinely different
 * (a work product links its task, a session shows its worktree). Pass
 * {@link FooterField} children.
 */
export function DetailFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
      {children}
    </footer>
  );
}
