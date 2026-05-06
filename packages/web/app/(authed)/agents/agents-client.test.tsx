import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AgentDisplay } from "@/lib/types/agents";
import type { AgentNetwork } from "@/lib/types/agent-network";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

vi.mock("@/lib/api/client", () => ({
  api: { agents: { list: vi.fn(), get: vi.fn(), network: vi.fn() } },
}));

import { AgentsClient } from "./agents-client";
import { api } from "@/lib/api/client";

const networkMock = vi.mocked(api.agents.network);

function renderAgents() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<AgentsClient />, { wrapper: Wrapper });
}

const baseAgent: AgentDisplay = {
  id: "agt_team",
  name: "alice's team",
  display_name: "Alice's team",
  hierarchy: "team",
  hierarchy_level: "team",
  owner_id: "u_alice",
  created_at: new Date(),
  updated_at: new Date(),
};

const baseIc: AgentDisplay = {
  ...baseAgent,
  id: "agt_ic",
  name: "backend",
  display_name: "Backend",
  hierarchy: "ic",
  hierarchy_level: "ic",
  parent_agent_id: "agt_team",
};

beforeEach(() => {
  apiState.isApiConfigured = true;
  networkMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentsClient", () => {
  it("renders the not-configured empty state when env is unset", () => {
    apiState.isApiConfigured = false;
    renderAgents();
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(networkMock).not.toHaveBeenCalled();
  });

  it("renders the no-agents empty state when self is empty", async () => {
    networkMock.mockResolvedValue({ self: [], peers: [] } satisfies AgentNetwork);
    renderAgents();
    expect(await screen.findByText("No agents yet")).toBeInTheDocument();
  });

  it("renders the team orbit with team center + IC ring when populated", async () => {
    networkMock.mockResolvedValue({
      self: [baseAgent, baseIc],
      peers: [],
    });
    renderAgents();
    expect(await screen.findByText("Alice's team")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();
  });

  it("renders peer orbits when the network includes other owners", async () => {
    networkMock.mockResolvedValue({
      self: [baseAgent],
      peers: [
        {
          owner_id: "u_dan",
          owner_label: "Daniel",
          agents: [
            {
              ...baseAgent,
              id: "agt_d_team",
              display_name: "Roadmap pod",
              owner_id: "u_dan",
            },
          ],
        },
      ],
    });
    renderAgents();
    expect(await screen.findByText("People you collaborate with")).toBeInTheDocument();
    expect(screen.getByText("Daniel's team")).toBeInTheDocument(); // section header
    expect(screen.getByText("Roadmap pod")).toBeInTheDocument(); // agent card
  });
});
