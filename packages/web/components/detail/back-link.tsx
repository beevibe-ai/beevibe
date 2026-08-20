import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * The "← Section" breadcrumb that sits above every detail page's header.
 * Every detail surface rendered the same inline-flex arrow-plus-label link,
 * varying only in `href` and `label`; this is the one declaration of it.
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
