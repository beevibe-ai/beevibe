import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";

/**
 * An {@link EmptyState} inside the dashed-border card the overview pages
 * put it in.
 *
 * The wrapper is one div and one class string, which is why it got
 * hand-written at all eight call sites that needed it — under three
 * different private names (`EmptyWrapper` in promotions-client,
 * `CenteredShell` in agents-client, anonymous inline elsewhere). Naming
 * it once keeps the dashed treatment from drifting the way the copy did.
 */
export function EmptyPanel({
  icon,
  title,
  description,
  cta,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  cta?: { href: string; label: string };
  /** Extra classes on the wrapper — width caps, centering. */
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-dashed border-border", className)}>
      <EmptyState icon={icon} title={title} description={description} cta={cta} />
    </div>
  );
}
