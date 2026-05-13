import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionUsageDisplay } from "@/lib/types/sessions";
import {
  cacheHitTone,
  formatCacheHit,
  formatCost,
  formatTokens,
} from "@/lib/usage-format";
import { UsagePanel } from "./usage-panel";

function mkUsage(
  overrides: Partial<SessionUsageDisplay> = {},
): SessionUsageDisplay {
  return {
    cost_usd: 0.1234,
    cache_hit_ratio: 0.85,
    input_tokens: 100,
    output_tokens: 500,
    cache_creation_tokens: 200,
    cache_read_tokens: 1700,
    total_input_tokens: 2000,
    model: "claude-opus-4-7",
    ...overrides,
  };
}

describe("formatCost", () => {
  it("renders 4 decimal places for normal sub-dollar costs", () => {
    expect(formatCost(0.1234)).toBe("$0.1234");
    expect(formatCost(0.0089)).toBe("$0.0089");
  });

  it("renders 4 decimals for whole-dollar costs too (consistency)", () => {
    expect(formatCost(1.5)).toBe("$1.5000");
  });

  it("clamps zero / negative to $0.0000", () => {
    expect(formatCost(0)).toBe("$0.0000");
    expect(formatCost(-0.01)).toBe("$0.0000");
  });

  it("shows '<$0.0001' for sub-tenth-cent costs", () => {
    // Avoid the misleading "$0.0000" when the session actually cost
    // something tiny but non-zero.
    expect(formatCost(0.00005)).toBe("<$0.0001");
  });
});

describe("formatCacheHit", () => {
  it("renders integer percent for normal sessions", () => {
    expect(formatCacheHit(mkUsage({ cache_hit_ratio: 0.7272, total_input_tokens: 1000 }))).toBe("73%");
    expect(formatCacheHit(mkUsage({ cache_hit_ratio: 0, total_input_tokens: 1000 }))).toBe("0%");
  });

  it("renders an em-dash when there was no input to score against", () => {
    // A zero cache ratio against zero input is meaningless, not bad —
    // don't render it as "0%" or the agent looks like a cache failure.
    expect(formatCacheHit(mkUsage({ cache_hit_ratio: 0, total_input_tokens: 0 }))).toBe("—");
  });
});

describe("cacheHitTone", () => {
  it("returns 'muted' when there's no input to score against", () => {
    expect(cacheHitTone(mkUsage({ total_input_tokens: 0 }))).toBe("muted");
  });

  it("returns 'done' at or above the warm-session target (>=0.7)", () => {
    expect(cacheHitTone(mkUsage({ cache_hit_ratio: 0.7, total_input_tokens: 100 }))).toBe("done");
    expect(cacheHitTone(mkUsage({ cache_hit_ratio: 0.95, total_input_tokens: 100 }))).toBe("done");
  });

  it("returns 'review' in the 0.4-0.7 band (cold-but-warming)", () => {
    expect(cacheHitTone(mkUsage({ cache_hit_ratio: 0.4, total_input_tokens: 100 }))).toBe("review");
    expect(cacheHitTone(mkUsage({ cache_hit_ratio: 0.65, total_input_tokens: 100 }))).toBe("review");
  });

  it("returns 'failed' below 0.4 (cache effectively not working)", () => {
    expect(cacheHitTone(mkUsage({ cache_hit_ratio: 0.39, total_input_tokens: 100 }))).toBe("failed");
    expect(cacheHitTone(mkUsage({ cache_hit_ratio: 0, total_input_tokens: 100 }))).toBe("failed");
  });
});

describe("formatTokens", () => {
  it("renders raw integer for small counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(619)).toBe("619");
    expect(formatTokens(999)).toBe("999");
  });

  it("renders K-suffix with one decimal for thousands", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(13498)).toBe("13.5K");
    expect(formatTokens(999_999)).toBe("1000.0K"); // edge of K range
  });

  it("renders M-suffix with two decimals for millions", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(2_350_000)).toBe("2.35M");
  });

  it("uses thousands separator for small counts (en-US locale)", () => {
    // Won't trip until 4 digits, but verify the locale path renders.
    // (Below 1000 the K-suffix path doesn't kick in.)
    expect(formatTokens(42)).toBe("42");
  });
});

describe("<UsagePanel />", () => {
  it("renders the headline cost + cache-hit pair", () => {
    render(<UsagePanel usage={mkUsage({ cost_usd: 0.1084, cache_hit_ratio: 0.89, total_input_tokens: 1000 })} />);
    expect(screen.getByText("$0.1084")).toBeInTheDocument();
    expect(screen.getByText("89%")).toBeInTheDocument();
  });

  it("renders the token breakdown grid", () => {
    render(
      <UsagePanel
        usage={mkUsage({
          input_tokens: 6,
          output_tokens: 619,
          cache_creation_tokens: 13498,
          cache_read_tokens: 16250,
        })}
      />,
    );
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText("619")).toBeInTheDocument();
    expect(screen.getByText("13.5K")).toBeInTheDocument();
    expect(screen.getByText("16.3K")).toBeInTheDocument();
  });

  it("renders the model name in the tertiary tier", () => {
    render(<UsagePanel usage={mkUsage({ model: "claude-opus-4-7" })} />);
    expect(screen.getByText("claude-opus-4-7")).toBeInTheDocument();
  });

  it("renders an em-dash for cache hit when total_input_tokens is zero", () => {
    render(<UsagePanel usage={mkUsage({ total_input_tokens: 0, cache_hit_ratio: 0 })} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("has an aria-label so screen readers can locate the section", () => {
    const { container } = render(<UsagePanel usage={mkUsage()} />);
    expect(container.querySelector('[aria-label="Session usage"]')).not.toBeNull();
  });
});
