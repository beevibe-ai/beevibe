import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { ListGate, apiNotConfiguredDescription, loadFailedTitle } from "./load-gate";

type Row = { name: string };

function renderGate(
  query: { data: Row[] | undefined; isLoading: boolean; isError: boolean },
  extra: { errorDescription?: string; empty?: React.ReactNode } = {},
) {
  return render(
    <ListGate
      noun="runtimes"
      query={query}
      skeleton={<div data-testid="skeleton" />}
      errorDescription={extra.errorDescription}
      isEmpty={(rows: Row[]) => rows.length === 0}
      empty={extra.empty}
    >
      {(rows) => <div data-testid="body">{rows.map((r) => r.name).join(",")}</div>}
    </ListGate>,
  );
}

const loaded = { data: [{ name: "claude" }], isLoading: false, isError: false };

describe("ListGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the rows are in hand", () => {
    renderGate(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("claude");
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("renders the skeleton while loading, never the body", () => {
    renderGate({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // A settled query that produced nothing is not a success — rendering the
  // body against `undefined` is what the hand-rolled `!data` branches kept
  // getting wrong (one returned bare `null`, flashing blank).
  it("holds the skeleton when a settled query has no data", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  // The whole point of the extraction: an unset env var must never be
  // reported as "you have no data yet".
  it("derives both messages from the noun", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(
      screen.getByText("Set NEXT_PUBLIC_BV_API_URL and run the API server to load runtimes."),
    ).toBeInTheDocument();
  });

  it("falls back to the shared error description", () => {
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load runtimes")).toBeInTheDocument();
    expect(screen.getByText("Check that the API server is reachable.")).toBeInTheDocument();
  });

  it("prefers a caller-supplied error description", () => {
    renderGate({ data: undefined, isLoading: false, isError: true }, {
      errorDescription: "connect ECONNREFUSED 127.0.0.1:3000",
    });
    expect(screen.getByText("connect ECONNREFUSED 127.0.0.1:3000")).toBeInTheDocument();
  });

  it("renders the empty state for a successful fetch with no rows", () => {
    renderGate({ data: [], isLoading: false, isError: false }, {
      empty: <div data-testid="empty" />,
    });
    expect(screen.getByTestId("empty")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // Without an `empty` node there is nothing to swap in, so the body owns
  // the zero-row case rather than the gate blanking the page.
  it("falls through to the body when no empty node is given", () => {
    renderGate({ data: [], isLoading: false, isError: false });
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });
});

describe("gate copy", () => {
  it("names the API server the same way in both messages", () => {
    expect(apiNotConfiguredDescription("tasks")).toContain("API server");
    expect(loadFailedTitle("tasks")).toBe("Couldn't load tasks");
  });
});
