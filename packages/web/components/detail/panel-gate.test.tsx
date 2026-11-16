import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { PanelGate } from "./panel-gate";

interface Row {
  name: string;
}

function renderGate(query: { data: Row | undefined; isLoading: boolean; isError: boolean }) {
  return render(
    <PanelGate
      noun="agent"
      id="agent_7"
      query={query}
      skeleton={<div data-testid="skeleton" />}
    >
      {(row) => <div data-testid="body">{row.name}</div>}
    </PanelGate>,
  );
}

describe("PanelGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the row is in hand, with no padding wrapper", () => {
    const { container } = renderGate({
      data: { name: "Ada's team" },
      isLoading: false,
      isError: false,
    });
    expect(screen.getByTestId("body")).toHaveTextContent("Ada's team");
    // The PeekPanel shell owns the body's padding; a wrapper here would
    // double it.
    expect(container.querySelector(".p-4, .p-5")).toBeNull();
  });

  it("pads the skeleton like the layout it stands in for", () => {
    const { container } = renderGate({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(container.querySelector(".p-5")).not.toBeNull();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  // Same two messages as the full-page DetailGate — that shared wording is
  // the point of the extraction, since the panels used to word both states
  // their own way.
  it("derives both messages from the noun and echoes the id", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(
      screen.getByText(/run the API server to load this agent\./),
    ).toBeInTheDocument();

    apiState.isApiConfigured = true;
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(screen.getByText(/Agent agent_7 could not be fetched\./)).toBeInTheDocument();
  });

  it("treats settled-but-empty as a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});
