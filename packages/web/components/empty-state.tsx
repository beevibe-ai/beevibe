import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /**
   * Optional call-to-action — typically used to bounce the user back to
   * the chat surface so they can ask their team agent to populate this
   * page ("ask my agent to mint a task," "show the mesh," …). The chat
   * is the primary entry point per the M8 onboarding design.
   */
  cta?: { href: string; label: string };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, cta, className }: Props) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-12 px-6 text-sm",
        className,
      )}
    >
      {Icon ? <Icon className="h-6 w-6 text-muted-foreground/60 mb-3" /> : null}
      <p className="font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 text-muted-foreground max-w-sm leading-relaxed">{description}</p>
      ) : null}
      {cta ? (
        <Link
          href={cta.href}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity px-3 py-1.5 text-xs font-medium cursor-pointer"
        >
          {cta.label}
          <ArrowRight className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}
