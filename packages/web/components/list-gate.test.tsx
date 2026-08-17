import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { ListGate } from "./list-gate";

interface Row {
  name: string;
}

type Query = { data: Row[] | undefined; isLoading: boolean; isError: boolean };

function renderGate(query: Query, extra: { empty?: { title: string } } = {}) {
  return render(
    <ListGate
      query={query}
      noun="promotion events"
      skeleton={<div data-testid="skeleton" />}
      empty={extra.empty}
    >
      {(rows) => <div data-testid="body">{rows.map((r) => r.name).join(",")}</div>}
    </ListGate>,
  );
}

const loaded: Query = {
  data: [{ name: "Design doc" }],
  isLoading: false,
  isError: false,
};

describe("ListGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the rows are in hand", () => {
    renderGate(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("Design doc");
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("renders the skeleton while loading, never the body", () => {
    renderGate({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // Same precedence as DetailGate: an unconfigured API is the reason the
  // fetch failed, so saying "couldn't load" first would misdiagnose it.
  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("derives both messages from the noun", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(
      screen.getByText(/run the API server to load promotion events\./),
    ).toBeInTheDocument();
  });

  it("falls back to the shared reachability hint on a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load promotion events")).toBeInTheDocument();
    expect(screen.getByText("Check that the API server is reachable.")).toBeInTheDocument();
  });

  it("renders the empty state for a settled-but-empty list", () => {
    renderGate({ data: [], isLoading: false, isError: false }, { empty: { title: "None yet" } });
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // A page whose content component draws its own empty state omits `empty`;
  // the gate must then render nothing rather than an untitled EmptyState.
  it("renders nothing when the list is empty and no empty copy was given", () => {
    const { container } = renderGate({ data: [], isLoading: false, isError: false });
    expect(container).toBeEmptyDOMElement();
  });

  // A query can settle without erroring and still hand back nothing. That
  // must not reach the body callback, which assumes data.
  it("treats settled-but-undefined as empty, not as body", () => {
    renderGate(
      { data: undefined, isLoading: false, isError: false },
      { empty: { title: "None yet" } },
    );
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("honors a custom isEmpty for payloads that wrap the list", () => {
    render(
      <ListGate
        query={{ data: { rows: [] }, isLoading: false, isError: false }}
        noun="runtimes"
        skeleton={<div />}
        isEmpty={(d) => d.rows.length === 0}
        empty={{ title: "None yet" }}
      >
        {() => <div data-testid="body" />}
      </ListGate>,
    );
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});
