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

import { HomeClient } from "./home-client";
import { api } from "@/lib/api/client";

const summaryMock = vi.mocked(api.dashboard.summary);

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<HomeClient />, { wrapper: Wrapper });
}

const sample: DashboardSummary = {
  kpis: [
    {
      label: "Active sessions",
      value: "12",
      meta: [{ text: "rolling 24h" }],
      href: "/tasks",
      trend: [1, 2, 3, 4, 5],
      trend_color: "running",
      trend_kind: "line",
    },
  ],
  status_breakdown: [
    { status: "in_progress", label: "running", color: "running", count: 7, percent: 50 },
  ],
  status_legend: [{ color: "running", label: "running", count: 7 }],
  status_total: 14,
  fleet: [{ hier: "ic", count: 3, percent: 60 }],
  fleet_total: 5,
  fleet_active: 2,
  fleet_idle: 3,
  trend: [{ label: "Mon", value: 4 }],
  trend_total: 28,
  trend_change_percent: 12,
  attention: [
    { status: "blocked", title: "needs key", age: "2h", href: "/tasks/t1" },
  ],
};

beforeEach(() => {
  apiState.isApiConfigured = true;
  summaryMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("HomeClient", () => {
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

  it("renders KPIs + breakdown + fleet + attention when data is loaded", async () => {
    summaryMock.mockResolvedValue(sample);
    renderHome();
    expect(await screen.findByText("Active sessions")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("needs key")).toBeInTheDocument();
  });
});
