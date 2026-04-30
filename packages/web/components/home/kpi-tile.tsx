import Link from "next/link";
import { cn } from "@/lib/utils";
import { BarSparkline, LineSparkline } from "./sparkline";
import type { KpiStat } from "@/lib/fixtures/dashboard-stats";

const META_COLOR = {
  muted: "text-muted-foreground",
  review: "text-status-review",
  done: "text-status-done",
  failed: "text-status-failed",
} as const;

const VALUE_COLOR = {
  running: "",
  review: "text-status-review",
  primary: "",
  done: "text-status-done",
} as const;

export function KpiTile({ stat }: { stat: KpiStat }) {
  return (
    <Link href={stat.href} className="group block">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
        {stat.label}
      </div>
      <div className="flex items-baseline gap-2">
        {stat.trend_color === "running" ? (
          <span className="animate-pulse-breathe inline-block h-2 w-2 rounded-full bg-status-running self-center" />
        ) : null}
        <span
          className={cn(
            "text-3xl font-semibold tabular-nums leading-none",
            VALUE_COLOR[stat.trend_color],
          )}
        >
          {stat.value}
        </span>
        {stat.unit ? <span className="text-sm text-muted-foreground">{stat.unit}</span> : null}
      </div>
      <div className={cn("mt-2 text-xs", META_COLOR[stat.meta_color ?? "muted"])}>
        {stat.meta}
      </div>
      {stat.trend_kind === "line" ? (
        <LineSparkline values={stat.trend} color={stat.trend_color} />
      ) : (
        <BarSparkline values={stat.trend} color={stat.trend_color} />
      )}
    </Link>
  );
}
