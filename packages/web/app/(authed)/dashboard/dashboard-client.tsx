"use client";

import { AlertTriangle, LayoutDashboard } from "lucide-react";
import { useDashboard } from "@/lib/hooks/use-dashboard";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { KpiTileSkeleton } from "@/components/skeletons";
import { KpiTile } from "@/components/home/kpi-tile";
import { FleetBars } from "@/components/home/fleet-bars";
import { StatusBreakdownBar } from "@/components/home/status-breakdown";
import { TrendChart } from "@/components/home/trend-chart";
import { DashboardUsageSection } from "@/components/home/usage-section";
import type { DashboardDisplay } from "@/lib/types/dashboard";

export function DashboardClient() {
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
  data: DashboardDisplay | undefined;
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
            <KpiTileSkeleton key={i} />
          ))}
        </div>
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  // /agents (the Home tab) is the front door now — that's where the
  // orbit lives. /dashboard is the "Metrics" sub-page under
  // Observability: KPIs, status, fleet, trend. Items needing decisions
  // are surfaced in the sidebar Inbox, so we don't repeat them here.
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Metrics</h1>
        <p className="mt-1 text-sm text-muted-foreground max-w-prose">
          Throughput, fleet activity, and trends across your team&apos;s work.
        </p>
      </header>

      <div className="grid grid-cols-4 gap-6">
        {data.kpis.map((stat, i) => (
          <KpiTile key={i} stat={stat} />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 rounded-lg glass-surface p-5">
          <StatusBreakdownBar
            entries={data.status_breakdown}
            legend={data.status_legend}
            total={data.status_total}
          />
        </div>
        <div className="rounded-lg glass-surface p-5">
          <FleetBars
            bars={data.fleet}
            total={data.fleet_total}
            active={data.fleet_active}
            idle={data.fleet_idle}
          />
        </div>
      </div>

      <div className="rounded-lg glass-surface p-5">
        <TrendChart
          days={data.trend}
          total={data.trend_total}
          changePercent={data.trend_change_percent}
        />
      </div>

      <DashboardUsageSection summary={data.usage_summary} />
    </div>
  );
}
