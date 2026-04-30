import { cn } from "@/lib/utils";
import type { StatusBreakdownEntry, StatusLegendEntry } from "@/lib/types/dashboard";

const COLOR_CLASS = {
  pending: "bg-status-pending",
  running: "bg-status-running",
  review: "bg-status-review",
  blocked: "bg-status-blocked",
  done: "bg-status-done",
  failed: "bg-status-failed",
} as const;

const DOT_CLASS = {
  pending: "bg-status-pending",
  running: "bg-status-running",
  review: "bg-status-review",
  blocked: "bg-status-blocked",
  done: "bg-status-done",
  failed: "bg-status-failed",
} as const;

export function StatusBreakdownBar({
  entries,
  legend,
  total,
}: {
  entries: StatusBreakdownEntry[];
  legend: StatusLegendEntry[];
  total: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Tasks by status
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="text-foreground tabular-nums">{total}</span> total
        </div>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden mb-3">
        {entries.map((e, i) => (
          <div
            key={`${e.status}-${i}`}
            className={COLOR_CLASS[e.color]}
            style={{ width: `${e.percent}%`, opacity: e.opacity ?? 1 }}
            title={`${e.label} ${e.count}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        {legend.map((l) => (
          <div key={l.label} className="flex items-center gap-2">
            <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[l.color])} />
            <span className="text-muted-foreground flex-1">{l.label}</span>
            <span className="font-mono tabular-nums">{l.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
