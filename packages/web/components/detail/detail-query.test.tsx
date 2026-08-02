import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Bot } from "lucide-react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { DetailQuery } from "./detail-query";

afterEach(() => {
  apiState.isApiConfigured = true;
});

type Row = { name: string };

function renderGate(
  query: { data: Row | undefined; isLoading: boolean; isError: boolean },
  nav?: React.ReactNode,
) {
  return render(
    <DetailQuery
      query={query}
      nav={nav}
      icon={Bot}
      entity="work product"
      entityId="wp_42"
      skeleton={<div data-testid="skeleton" />}
    >
      {(row) => <p>loaded {row.name}</p>}
    </DetailQuery>,
  );
}

const loading = { data: undefined, isLoading: true, isError: false };
const errored = { data: undefined, isLoading: false, isError: true };
const ready = { data: { name: "hello" }, isLoading: false, isError: false };

describe("DetailQuery", () => {
  it("gates on configuration before it looks at the query at all", () => {
    apiState.isApiConfigured = false;
    // Even with data in hand, an unconfigured client can't have fetched it.
    renderGate(ready);
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/loaded/)).not.toBeInTheDocument();
  });

  it("renders the page's own skeleton while loading", () => {
    renderGate(loading);
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
  });

  it("capitalizes the entity noun in the error copy but not the title", () => {
    renderGate(errored);
    expect(screen.getByText("Couldn't load work product")).toBeInTheDocument();
    expect(
      screen.getByText("Work product wp_42 could not be fetched. Check the api server logs."),
    ).toBeInTheDocument();
  });

  it("treats a successful-but-empty query as an error, not as data", () => {
    // `isError` stays false when a query resolves to undefined; the gate has
    // to catch that or the children would destructure nothing.
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load work product")).toBeInTheDocument();
  });

  it("hands the narrowed data to children and adds no shell of its own", () => {
    // The loaded branch is deliberately unwrapped: pages render their own
    // DetailShell, sometimes with a different nav than the gates use.
    const { container } = renderGate(ready, <span>back</span>);
    expect(screen.getByText("loaded hello")).toBeInTheDocument();
    expect(screen.queryByText("back")).not.toBeInTheDocument();
    expect(container.firstChild).toStrictEqual(screen.getByText("loaded hello"));
  });

  it("renders the nav above every gate branch", () => {
    for (const query of [loading, errored]) {
      const { unmount } = renderGate(query, <span>back</span>);
      expect(screen.getByText("back")).toBeInTheDocument();
      unmount();
    }
  });
});
