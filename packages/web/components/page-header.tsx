import type { ReactNode } from "react";

/**
 * Shared horizontal page header for top-level routes like /agents,
 * /tasks, /rooms — title on the left, optional subtitle, actions slot
 * on the right. Matches the strip /tasks shipped first; any new page
 * with a header band should use this so spacing and typography stay
 * consistent without each route re-deriving them.
 *
 * Actions go in `children` so callers can compose freely (toggles,
 * search boxes, archive chips, etc.).
 */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-border/60 shrink-0">
      <h1 className="text-base font-semibold tracking-tight leading-none">
        {title}
      </h1>
      {subtitle ? (
        <p className="text-xs text-muted-foreground leading-none flex-1 min-w-0 truncate">
          {subtitle}
        </p>
      ) : (
        <div className="flex-1" />
      )}
      {children ? (
        <div className="shrink-0 flex items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}
