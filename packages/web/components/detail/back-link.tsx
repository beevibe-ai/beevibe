import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The "← Somewhere" link every detail page opens with.
 *
 * Seven pages had spelled out the same `<Link><ArrowLeft/>{label}</Link>`
 * with the same class string, four of them as a private
 * `const XBackLink = () => …` differing only in href and label. An eighth
 * copy lived in `mesh-back-link.tsx` as a component hard-coded to `/mesh` —
 * the right idea, one parameter short of being reusable, so the next page
 * that needed one copied the markup instead of importing it.
 *
 * Callers standing the link on its own above a page body pass
 * `className="mb-3"`; the ones that sit inside a breadcrumb row leave it
 * off and let the row space them.
 */
export function BackLink({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors",
        className,
      )}
    >
      <ArrowLeft className="h-3 w-3" />
      {label}
    </Link>
  );
}
