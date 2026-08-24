import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A monospaced link to another entity — the id-shaped cross-reference that
 * shows up in detail footers and side panels ("Parent: task_a1b2c3").
 *
 * Five call sites wrote the identical `font-mono hover:text-foreground
 * transition-colors` triple inline. `ClickToCopyId` deliberately keeps its
 * own class list: it is a button with an icon and extra layout classes, not
 * a navigation link.
 */
export function MonoLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-mono hover:text-foreground transition-colors">
      {children}
    </Link>
  );
}
