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

  it("renders the no-agents empty state when api returns []", async () => {
    listMock.mockResolvedValue([]);
    renderAgents();
    expect(await screen.findByText("No agents yet")).toBeInTheDocument();
  });

  it("renders the team orbit with team center + IC ring when populated", async () => {
    listMock.mockResolvedValue([
      { ...baseAgent, id: "team_1", display_name: "Alice's team", hierarchy: "team" },
      { ...baseAgent, id: "ic_1", display_name: "Backend", parent_agent_id: "team_1", sessions_count: 5 },
      { ...baseAgent, id: "ic_2", display_name: "Frontend", parent_agent_id: "team_1", sessions_count: 12 },
    ]);
    renderAgents();
    expect(await screen.findByText("Alice's team")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();
    expect(screen.getByText("Frontend")).toBeInTheDocument();
  });
});
