import Link from "next/link";
import { AlertCircle, ArrowRight, Ban, XCircle } from "lucide-react";
import { KpiTile } from "@/components/home/kpi-tile";
import { StatusBreakdownBar } from "@/components/home/status-breakdown";
import { FleetBars } from "@/components/home/fleet-bars";
import { TrendChart } from "@/components/home/trend-chart";
import {
  fixtureAttention,
  fixtureFleetActive,
  fixtureFleetBars,
  fixtureKpis,
  fixtureLeadLine,
  fixtureStatusBreakdown,
  fixtureStatusLegend,
  fixtureStatusTotal,
  fixtureTrend7d,
  fixtureTrendStats,
} from "@/lib/fixtures/dashboard-stats";
import { fixtureFleetCounts } from "@/lib/fixtures/agents";

const ATTENTION_ICON = {
  blocked: { icon: Ban, color: "text-status-blocked" },
  failed: { icon: XCircle, color: "text-status-failed" },
  review: { icon: AlertCircle, color: "text-status-review" },
} as const;

export default function HomePage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-12 px-6">
        <div className="mb-10 text-sm text-muted-foreground flex items-center gap-3">
          <span className="text-foreground font-medium">{fixtureLeadLine.date}</span>
          <span className="text-border">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-status-done" />
            {fixtureLeadLine.fleet_health}
          </span>
          <span className="text-border">·</span>
          <span>
            last activity{" "}
            <span className="text-foreground tabular-nums">
              {fixtureLeadLine.last_activity_seconds}s ago
            </span>
          </span>
        </div>

        <div className="grid grid-cols-4 gap-x-10 mb-14">
          {fixtureKpis.map((stat) => (
            <KpiTile key={stat.label} stat={stat} />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-x-10 mb-14">
          <div className="col-span-2">
            <StatusBreakdownBar
              entries={fixtureStatusBreakdown}
              legend={fixtureStatusLegend}
              total={fixtureStatusTotal}
            />
          </div>
          <FleetBars
            bars={fixtureFleetBars}
            total={fixtureFleetCounts.total}
            active={fixtureFleetActive.active}
            idle={fixtureFleetActive.idle}
          />
        </div>

        <div className="mb-14">
          <TrendChart
            days={fixtureTrend7d}
            total={fixtureTrendStats.total}
            changePercent={fixtureTrendStats.change_percent}
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Needs a look
            </div>
            <Link
              href="/tasks"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <ul className="space-y-1">
            {fixtureAttention.map((item) => {
              const { icon: Icon, color } = ATTENTION_ICON[item.status];
              return (
                <li key={item.title}>
                  <Link
                    href={item.href}
                    className="flex items-center gap-3 px-2 py-2 -mx-2 rounded hover:bg-secondary/40 cursor-pointer transition-colors"
                  >
                    <Icon className={`h-4 w-4 ${color} shrink-0`} />
                    <span className="text-sm flex-1 truncate">{item.title}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{item.age}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
