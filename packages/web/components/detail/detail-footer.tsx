import type { ReactNode } from "react";

/**
 * The metadata footer beneath every detail page — a 2/4-column grid of
 * {@link FooterField}s. The `<footer>` styling was copied verbatim across
 * seven detail clients; this owns it so the grid, border and type scale
 * stay in one place.
 */
export function DetailFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
      {children}
    </footer>
  );
}
