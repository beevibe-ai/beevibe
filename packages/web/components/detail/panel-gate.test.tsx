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
    <PanelGate noun="agent" id="agent_42" query={query} skeleton={<div data-testid="skeleton" />}>
      {(row) => <div data-testid="body">{row.name}</div>}
    </PanelGate>,
  );
}

describe("PanelGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the row is in hand", () => {
    renderGate({ data: { name: "Scout" }, isLoading: false, isError: false });
    expect(screen.getByTestId("body")).toHaveTextContent("Scout");
  });

  it("renders the skeleton while loading, with no padding wrapper of its own", () => {
    const { container } = renderGate({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(container.querySelector(".p-4")).toBeNull();
  });

  // The panels are flush to their own edge, so the empty states — unlike
  // the skeleton, which brings its own padding — need the wrapper.
  it("pads the empty states", () => {
    const { container } = renderGate({ data: undefined, isLoading: false, isError: true });
    expect(container.querySelector(".p-4")).not.toBeNull();
  });

  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  // Both panels used to word these two messages differently from the
  // detail pages. They are derived from `noun`/`id` now, so they can't.
  it("words both messages the same way the detail pages do", () => {
    apiState.isApiConfigured = false;
    const { unmount } = renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText(/run the API server to load this agent\./)).toBeInTheDocument();
    unmount();

    apiState.isApiConfigured = true;
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(
      screen.getByText(/Agent agent_42 could not be fetched\. Check the API server logs\./),
    ).toBeInTheDocument();
  });

  it("treats settled-but-empty as a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});
