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

function renderGate(
  query: { data: Row | undefined; isLoading: boolean; isError: boolean },
  emptyClassName?: string,
) {
  return render(
    <PanelGate
      noun="agent"
      id="ag_7"
      query={query}
      skeleton={<div data-testid="skeleton" />}
      emptyClassName={emptyClassName}
    >
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

  it("renders the skeleton while loading, never the body", () => {
    renderGate({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // The panel gate shares its copy with DetailGate via resolveDetailState —
  // these two assertions are what stop the peek panels drifting away from
  // the full pages again.
  it("uses the shared unconfigured copy", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(
      screen.getByText("Set NEXT_PUBLIC_BV_API_URL and run the API server to load this agent."),
    ).toBeInTheDocument();
  });

  it("uses the shared fetch-error copy", () => {
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(
      screen.getByText("Agent ag_7 could not be fetched. Check the API server logs."),
    ).toBeInTheDocument();
  });

  // The peek panels sit inside a padded PeekPanel; the room view supplies
  // its own centering instead. The wrapper is the only thing that varies.
  it("defaults the empty wrapper to the panel padding", () => {
    const { container } = renderGate({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    expect(container.firstElementChild).toHaveClass("p-4");
  });

  it("honours an overridden empty wrapper", () => {
    const { container } = renderGate(
      { data: undefined, isLoading: false, isError: true },
      "flex-1 flex items-center justify-center",
    );
    expect(container.firstElementChild).toHaveClass("justify-center");
    expect(container.firstElementChild).not.toHaveClass("p-4");
  });
});
