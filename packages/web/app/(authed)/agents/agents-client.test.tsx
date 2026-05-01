import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AgentDisplay } from "@/lib/types/agents";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

vi.mock("@/lib/api/client", () => ({
  api: { agents: { list: vi.fn(), get: vi.fn() } },
}));

import { AgentsClient } from "./agents-client";
import { api } from "@/lib/api/client";

const listMock = vi.mocked(api.agents.list);

function renderAgents() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<AgentsClient />, { wrapper: Wrapper });
}

const baseAgent: AgentDisplay = {
  id: "agt_1",
  name: "alice",
  display_name: "Alice",
  hierarchy: "ic",
  hierarchy_level: "ic",
  owner_id: "u_1",
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  apiState.isApiConfigured = true;
  listMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentsClient", () => {
  it("renders the not-configured empty state when env is unset", () => {
    apiState.isApiConfigured = false;
    renderAgents();
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("falls back to OrgChart + SpecializationTable when api returns []", async () => {
    listMock.mockResolvedValue([]);
    renderAgents();
    expect(
      await screen.findByRole("heading", { name: /Specialization depth/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("No agents yet").length).toBeGreaterThan(0);
  });

  it("renders agent rows with hierarchy chip + session count when populated", async () => {
    listMock.mockResolvedValue([
      { ...baseAgent, id: "a1", display_name: "Alice", sessions_count: 5 },
      { ...baseAgent, id: "a2", display_name: "Bob", hierarchy: "team", sessions_count: 12 },
    ]);
    renderAgents();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("5 sessions")).toBeInTheDocument();
    expect(screen.getByText("12 sessions")).toBeInTheDocument();
    expect(
      screen.getAllByText((_, el) => el?.textContent === "2 agents in your org.").length,
    ).toBeGreaterThan(0);
  });
});
