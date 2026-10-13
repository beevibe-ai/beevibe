import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { PanelGate, PanelSection } from "./peek-panel";

interface Row {
  name: string;
}

function renderGate(query: { data: Row | undefined; isLoading: boolean; isError: boolean }) {
  return render(
    <PanelGate noun="agent" id="agt_42" query={query} skeleton={<div data-testid="skeleton" />}>
      {(row) => <div data-testid="body">{row.name}</div>}
    </PanelGate>,
  );
}

const loaded = { data: { name: "Scout" }, isLoading: false, isError: false };

describe("PanelGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the row is in hand", () => {
    renderGate(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("Scout");
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("renders the skeleton while loading, never the body", () => {
    renderGate({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  // Both panels used to word these two messages themselves, and both
  // worded them differently from the routes. Sharing `gate-states` is what
  // stops that, so assert the panel now says what a route says.
  it("derives both messages from the noun, in the routes' wording", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText(/run the API server to load this agent\./)).toBeInTheDocument();
  });

  it("echoes the id in the fetch-error message", () => {
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(screen.getByText(/Agent agt_42 could not be fetched\./)).toBeInTheDocument();
  });

  // A query can settle without erroring and still hand back nothing (a 404
  // mapped to undefined). That has to land on the error state, not render
  // the body with a missing row.
  it("treats settled-but-empty as a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});

describe("PanelSection", () => {
  it("renders the count beside the title", () => {
    render(
      <PanelSection title="Sessions" count={3}>
        <div data-testid="rows" />
      </PanelSection>,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Sessions3");
    expect(screen.getByTestId("rows")).toBeInTheDocument();
  });

  it("swaps children for the empty copy at count 0", () => {
    render(
      <PanelSection title="Sessions" count={0} empty="No sessions yet.">
        <div data-testid="rows" />
      </PanelSection>,
    );
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("rows")).toBeNull();
  });

  // An omitted count is not a zero count: the single-row sections (the
  // active-session link, the description) pass no count and must still
  // render their child rather than fall through to `empty`.
  it("renders children when count is omitted, with no count in the heading", () => {
    render(
      <PanelSection title="Active session" empty="No sessions yet.">
        <div data-testid="rows" />
      </PanelSection>,
    );
    expect(screen.getByTestId("rows")).toBeInTheDocument();
    expect(screen.getByRole("heading")).toHaveTextContent("Active session");
    expect(screen.queryByText("No sessions yet.")).toBeNull();
  });

  it("keeps children when a count is set but empty copy is not", () => {
    render(
      <PanelSection title="Sessions" count={0}>
        <div data-testid="rows" />
      </PanelSection>,
    );
    expect(screen.getByTestId("rows")).toBeInTheDocument();
  });
});
