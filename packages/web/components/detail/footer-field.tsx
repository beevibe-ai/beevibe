import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function FooterField({
  label,
  children,
  truncate,
}: {
  label: string;
  children: ReactNode;
  truncate?: boolean;
}) {
  return (
    <div className={cn(truncate && "min-w-0")}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
        {label}
      </div>
      <div className={cn("text-foreground/80", truncate && "truncate")}>{children}</div>
    </div>
  );
}
