import type { RunStatus } from "@/lib/fixtures/repo-runs";
import { cn } from "@/lib/utils";

const STATUS: Record<
  RunStatus,
  { dot: string; text: string; label: string }
> = {
  running: {
    dot: "bg-status-running animate-pulse-breathe",
    text: "text-status-running",
    label: "Running",
  },
  succeeded: {
    dot: "bg-status-done",
    text: "text-status-done",
    label: "Done",
  },
  partial: {
    dot: "bg-status-review",
    text: "text-status-review",
    label: "Partial",
  },
  blocked: {
    dot: "bg-status-blocked",
    text: "text-status-blocked",
    label: "Couldn't run",
  },
  failed: {
    dot: "bg-status-failed",
    text: "text-status-failed",
    label: "Failed",
  },
};

export function RunStatusPill({
  status,
  className,
}: {
  status: RunStatus;
  className?: string;
}) {
  const s = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        "bg-card border border-border/60",
        s.text,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}
