import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The metadata strip every detail page closes with — a rule, then a
 * responsive grid of `FooterField`s.
 *
 * Seven pages (task, agent, session, chat session, work product,
 * escalation, negotiation) each carried a byte-identical copy of the
 * `<footer>` class string. What goes *in* the grid is per-page and stays
 * at the call site; only the frame is shared.
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

/**
 * `<FooterField label="CLI session">` + `<FooterField label="Worktree">`,
 * both mono and both conditional — the pair the session pages render
 * identically. Emits nothing for an absent value, matching the
 * hand-written `{x ? … : null}` they replace.
 */
export function MonoFooterField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <FooterField label={label} truncate>
      <span className="font-mono">{value}</span>
    </FooterField>
  );
}
