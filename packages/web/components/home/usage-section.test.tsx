import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  UsageAgentBreakdown,
  UsageSummaryData,
} from "@/lib/types/dashboard";
import { DashboardUsageSection } from "./usage-section";

function mkAgent(overrides: Partial<UsageAgentBreakdown> = {}): UsageAgentBreakdown {
  return {
    agent_id: "agt_x",
    agent_label: "alice",
    cost_usd: 0.5,
    sessions: 5,
    ...overrides,
  };
}

function mkSummary(overrides: Partial<UsageSummaryData> = {}): UsageSummaryData {
  return {
    window_days: 7,
    total_cost_usd: 1.0,
    prior_cost_usd: 0.5,
    cost_change_percent: 100,
    total_input_tokens: 100,
    total_output_tokens: 500,
    total_cache_creation_tokens: 200,
    total_cache_read_tokens: 1700,
    cache_hit_ratio: 1700 / 2000,
    total_sessions: 6,
    per_agent: [mkAgent()],
    ...overrides,
  };
}

describe("<DashboardUsageSection />", () => {
  it("renders the window label in the header", () => {
    render(<DashboardUsageSection summary={mkSummary({ window_days: 7 })} />);
    expect(screen.getByText("last 7 days")).toBeInTheDocument();
  });

  it("renders all four headline tiles", () => {
    render(
      <DashboardUsageSection
        summary={mkSummary({
          total_cost_usd: 0.1234,
          total_input_tokens: 1000,
          total_output_tokens: 500,
          total_sessions: 7,
        })}
      />,
    );
    expect(screen.getByText("$0.1234")).toBeInTheDocument();
    // tokens headline = input + output
    expect(screen.getByText("1.5K")).toBeInTheDocument();
    // cache hit pct
    expect(screen.getByText("85%")).toBeInTheDocument();
    // sessions count
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("renders an up-arrow delta when cost increased (cost up = bad → red tone)", () => {
    const { container } = render(
      <DashboardUsageSection
        summary={mkSummary({
          total_cost_usd: 2,
          prior_cost_usd: 1,
          cost_change_percent: 100,
        })}
      />,
    );
    // The percentage text always renders; the arrow icon is the
    // direction indicator. We assert the percentage is there and the
    // arrow svg renders (lucide icons render as <svg>).
    expect(screen.getByText(/100%/)).toBeInTheDocument();
    const arrows = container.querySelectorAll("svg.lucide-arrow-up");
    expect(arrows.length).toBeGreaterThanOrEqual(1);
  });

  it("renders a down-arrow delta when cost decreased (cost down = good → green tone)", () => {
    const { container } = render(
      <DashboardUsageSection
        summary={mkSummary({
          total_cost_usd: 0.5,
          prior_cost_usd: 1,
          cost_change_percent: -50,
        })}
      />,
    );
    // The render shows the absolute value of the delta.
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    const arrows = container.querySelectorAll("svg.lucide-arrow-down");
    expect(arrows.length).toBeGreaterThanOrEqual(1);
  });

  it("renders '—' for cost delta when both windows are zero", () => {
    render(
      <DashboardUsageSection
        summary={mkSummary({
          total_cost_usd: 0,
          prior_cost_usd: 0,
          cost_change_percent: 0,
        })}
      />,
    );
    // The CostTile meta renders an em-dash; the CacheHitTile also
    // renders an em-dash when total input is zero (which is also true
    // in this fixture since defaults include input but we override
    // both prior/current cost). The em-dash showing up at least once
    // is enough for this case.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("renders '—' for cache hit when there is no input in window", () => {
    render(
      <DashboardUsageSection
        summary={mkSummary({
          total_input_tokens: 0,
          total_cache_creation_tokens: 0,
          total_cache_read_tokens: 0,
          cache_hit_ratio: 0,
        })}
      />,
    );
    expect(screen.getByText("no input in window")).toBeInTheDocument();
  });

  it("renders per-agent bars when per_agent has entries", () => {
    render(
      <DashboardUsageSection
        summary={mkSummary({
          per_agent: [
            mkAgent({ agent_id: "agt_a", agent_label: "alice", cost_usd: 0.5, sessions: 5 }),
            mkAgent({ agent_id: "agt_b", agent_label: "bob", cost_usd: 0.1, sessions: 1 }),
          ],
        })}
      />,
    );
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    // Shows count of agents in the header.
    expect(screen.getByText("by agent · top 2")).toBeInTheDocument();
  });

  it("surfaces an overflow line when more than the top-N agents exist", () => {
    const agents: UsageAgentBreakdown[] = Array.from({ length: 7 }, (_, i) =>
      mkAgent({
        agent_id: `agt_${i}`,
        agent_label: `agent_${i}`,
        cost_usd: 0.1 * (7 - i),
      }),
    );
    render(<DashboardUsageSection summary={mkSummary({ per_agent: agents })} />);
    // 7 agents, top 5 shown → "+ 2 more agents"
    expect(screen.getByText("+ 2 more agents")).toBeInTheDocument();
  });

  it("renders an empty-state line when no agents have sessions in the window", () => {
    render(<DashboardUsageSection summary={mkSummary({ per_agent: [] })} />);
    expect(screen.getByText("No agent sessions in this window.")).toBeInTheDocument();
  });
});
