import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * The "← Section" link every detail page hands to `DetailGate` /
 * `DetailShell` as its `nav`.
 *
 * Four byte-identical copies existed before this — `MeshBackLink` as its
 * own component, plus a local `AgentsBackLink` / `TasksBackLink` /
 * `CapabilitiesBackLink` arrow-function at the top of each detail client.
 * They differed only in `href` and the label, so the shared class string
 * (which encodes the back-link's spacing and hover treatment) was repeated
 * four times and could drift in three of them unnoticed.
 *
 * Breadcrumb-style links that sit inside an existing `text-xs
 * text-muted-foreground` row — work-product's "Back to task", the chat
 * session's "Back to chat", memory eval's "Memory / Eval" — deliberately
 * do NOT use this: they inherit color and size from the row and must not
 * carry `mb-3`. They are a different component, not a variant of this one.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
    >
      <ArrowLeft className="h-3 w-3" />
      {label}
    </Link>
  );
}
