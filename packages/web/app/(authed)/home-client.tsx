"use client";

import Link from "next/link";
import { AlertTriangle, LayoutDashboard } from "lucide-react";
import { useDashboard } from "@/lib/hooks/use-dashboard";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { KpiTile } from "@/components/home/kpi-tile";
import { FleetBars } from "@/components/home/fleet-bars";
import { StatusBreakdownBar } from "@/components/home/status-breakdown";
import { TrendChart } from "@/components/home/trend-chart";
import type { DashboardSummary } from "@/lib/api/types";
import type { AttentionItem } from "@/lib/types/dashboard";

export function HomeClient() {
  const { data, isLoading, isError } = useDashboard();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-12 px-6">
        <Body data={data} isLoading={isLoading} isError={isError} />
      </div>
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
}: {
  data: DashboardSummary | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (!isApiConfigured) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          icon={LayoutDashboard}
          title="Dashboard not connected"
          description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load KPIs and fleet status."
        />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load dashboard"
          description="Check that the MCP server is reachable."
        />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-4 gap-6">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-6">
        {data.kpis.map((stat, i) => (
          <KpiTile key={i} stat={stat} />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 rounded-lg border border-border bg-card p-5">
          <StatusBreakdownBar
            entries={data.status_breakdown}
            legend={data.status_legend}
            total={data.status_total}
          />
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <FleetBars
            bars={data.fleet}
            total={data.fleet_total}
            active={data.fleet_active}
            idle={data.fleet_idle}
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <TrendChart
          days={data.trend}
          total={data.trend_total}
          changePercent={data.trend_change_percent}
        />
      </div>

      {data.attention.length > 0 ? (
        <section>
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Needs attention{" "}
            <span className="text-muted-foreground/70 tabular-nums">{data.attention.length}</span>
          </h2>
          <ul className="space-y-2">
            {data.attention.map((item, i) => (
              <AttentionRow key={i} item={item} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const dot =
    item.status === "blocked"
      ? "bg-status-blocked"
      : item.status === "failed"
        ? "bg-status-failed"
        : "bg-status-review";
  return (
    <li>
      <Link
        href={item.href}
        className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 hover:bg-secondary/30 transition-colors"
      >
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} aria-hidden />
        <span className="flex-1 min-w-0 truncate text-sm">{item.title}</span>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">{item.age}</span>
      </Link>
    </li>
  );
}
