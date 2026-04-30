import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "animate-pulse rounded bg-secondary/60",
        className,
      )}
    />
  );
}
