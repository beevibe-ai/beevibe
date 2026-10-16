import type { ReactNode } from "react";
import Link from "next/link";
import { ClickToCopyId } from "./click-to-copy-id";
import { FooterField } from "./footer-field";

/**
 * The metadata grid every detail page closes with.
 *
 * All seven detail pages — agent, task, session, chat session, escalation,
 * negotiation, work product — spelled out the same `<footer>` with the same
 * 9-class string, and six of them opened it with the same copyable-id field.
 * Seven copies of a layout is seven places a column count or a border tint
 * can drift, and the id field is the part most likely to be forgotten on a
 * new page, so it is baked in here rather than left to the caller.
 *
 * `idLabel` exists because the noun differs: the session pages label theirs
 * "Session ID" / "Conversation ID" to say which of the two ids on the page
 * is being copied. The remaining fields stay `children` — they are genuinely
 * per-resource, and `FooterField` already carries their shape.
 */
export function DetailFooter({
  id,
  idLabel = "ID",
  children,
}: {
  id: string;
  idLabel?: string;
  children?: ReactNode;
}) {
  return (
    <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
      <FooterField label={idLabel}>
        <ClickToCopyId id={id} />
      </FooterField>
      {children}
    </footer>
  );
}

/**
 * A footer field whose value links elsewhere — the related task, the parent
 * task, the negotiation. Four of the footers wrote this `<Link>` out with an
 * identical className; the monospace is load-bearing (the label is an id or
 * a short id, which reads as a wall of text in the body font).
 */
export function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-mono hover:text-foreground transition-colors">
      {children}
    </Link>
  );
}
