import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DashboardSummary } from "@/lib/api/types";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

vi.mock("@/lib/api/client", () => ({
  api: { dashboard: { summary: vi.fn() } },
}));

import { DashboardClient } from "./dashboard-client";
import { api } from "@/lib/api/client";

const summaryMock = vi.mocked(api.dashboard.summary);

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<DashboardClient />, { wrapper: Wrapper });
}

const sample: DashboardSummary = {
  kpis: [
    { kind: "active_sessions", value: 12, unit: "running", trend: [1, 2, 3, 4, 5] },
  ],
  status_breakdown: [{ status: "in_progress", count: 7, percent: 50 }],
  status_legend: [{ bucket: "running", count: 7 }],
  status_total: 14,
  fleet: [{ hier: "ic", count: 3, percent: 60 }],
  fleet_total: 5,
  fleet_active: 2,
  fleet_idle: 3,
  trend: [{ date: "2026-04-30", value: 4, is_today: true }],
  trend_total: 28,
  trend_change_percent: 12,
  attention: [
    {
      task_id: "t1",
      title: "needs key",
      status: "blocked",
      created_at: new Date("2026-04-30T10:00:00Z"),
    },
  ],
  usage_summary: {
    window_days: 7,
    total_cost_usd: 0,
    prior_cost_usd: 0,
    cost_change_percent: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cache_read_tokens: 0,
    cache_hit_ratio: 0,
    total_sessions: 0,
    per_agent: [],
  },
};

beforeEach(() => {
  apiState.isApiConfigured = true;
  summaryMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DashboardClient", () => {
  it("renders the not-configured empty state and never fetches", () => {
    apiState.isApiConfigured = false;
    renderHome();
    expect(screen.getByText("Dashboard not connected")).toBeInTheDocument();
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it("renders the error empty state when fetch fails", async () => {
    summaryMock.mockRejectedValue(new Error("boom"));
    renderHome();
    expect(await screen.findByText("Couldn't load dashboard")).toBeInTheDocument();
  });

  it("renders the Metrics header + KPIs + breakdown + fleet when data is loaded", async () => {
    summaryMock.mockResolvedValue(sample);
    renderHome();
    expect(await screen.findByText("Active sessions")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Metrics" })).toBeInTheDocument();
  });
});
