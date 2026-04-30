import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  icon?: LucideIcon;
  title: string;
  description?: string;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, className }: Props) {
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
    </div>
  );
}
