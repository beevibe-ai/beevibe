import { cn } from "@/lib/utils";
import type { FleetBar } from "@/lib/types/dashboard";

const HIER_FILL = {
  org: "bg-hier-org",
  team: "bg-hier-team",
  ic: "bg-hier-ic",
} as const;

export function FleetBars({
  bars,
  total,
  active,
  idle,
}: {
  bars: FleetBar[];
  total: number;
  active: number;
  idle: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Fleet</div>
        <div className="text-xs text-muted-foreground">
          <span className="text-foreground tabular-nums">{total}</span> agents
        </div>
      </div>
      <div className="space-y-2 text-xs">
        {bars.map((b) => (
          <div key={b.hier} className="flex items-center gap-2">
            <span className="text-muted-foreground w-10 text-right">{b.hier}</span>
            <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className={cn("h-full", HIER_FILL[b.hier])} style={{ width: `${b.percent}%` }} />
            </div>
            <span className="font-mono tabular-nums w-4 text-right">{b.count}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 text-xs text-muted-foreground flex items-center gap-2">
        <span className="animate-pulse-breathe inline-block h-1.5 w-1.5 rounded-full bg-status-running" />
        <span>
          <span className="text-foreground tabular-nums">{active}</span> active
        </span>
        <span className="text-border">·</span>
        <span>
          <span className="text-foreground tabular-nums">{idle}</span> idle
        </span>
      </div>
    </div>
  );
}
