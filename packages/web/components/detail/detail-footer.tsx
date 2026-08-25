import type { ReactNode } from "react";

/**
 * The metadata strip at the bottom of every detail page — a responsive grid
 * of `<FooterField>`s holding ids, timestamps and cross-links.
 *
 * `FooterField` was already shared, but all seven detail pages carried
 * their own copy of the wrapper's Tailwind string, so the grid, spacing and
 * rule above it could drift page to page. This is the one definition.
 */
export function DetailFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
      {children}
    </footer>
  );
}
