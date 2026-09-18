import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/** Shared by both variants — the only thing `standalone` adds is the margin. */
const BASE =
  "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors";

/**
 * The "← Somewhere" link every detail page opens with.
 *
 * Seven pages carried their own copy — `MeshBackLink` plus a local
 * `AgentsBackLink` / `TasksBackLink` / `CapabilitiesBackLink` / `BackToChat`
 * and two written inline — all the same `<Link>` wrapping the same
 * `ArrowLeft` at the same size, differing only in href and label.
 *
 * `variant` is the one real difference and stays explicit:
 *
 *   - `standalone` (default) — the link *is* the page's nav, so it carries
 *     its own `mb-3` to separate itself from the content below. This is what
 *     `DetailShell`'s `nav` slot takes on the agent, task, capability-run,
 *     escalation and negotiation pages.
 *   - `inline` — the link sits in a breadcrumb row (work product, chat
 *     session, memory eval) whose container owns the spacing, so a second
 *     bottom margin here would push the row's other segments out of line.
 *
 * Both keep `text-xs text-muted-foreground`. Two of the three breadcrumb
 * containers also set those, but the work-product row does not and relied on
 * the link declaring them — so they belong on the link, and re-declaring the
 * same values under the other two containers changes nothing.
 */
export function BackLink({
  href,
  label,
  variant = "standalone",
}: {
  href: string;
  label: string;
  variant?: "standalone" | "inline";
}) {
  return (
    <Link href={href} className={variant === "standalone" ? `${BASE} mb-3` : BASE}>
      <ArrowLeft className="h-3 w-3" />
      {label}
    </Link>
  );
}
