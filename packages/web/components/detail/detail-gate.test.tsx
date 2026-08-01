import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { DetailGate } from "./detail-gate";

interface Row {
  name: string;
}

function renderGate(
  query: { data: Row | undefined; isLoading: boolean; isError: boolean },
  nav?: React.ReactNode,
) {
  return render(
    <DetailGate
      nav={nav}
      noun="work product"
      id="wp_42"
      query={query}
      skeleton={<div data-testid="skeleton" />}
    >
      {(row) => <div data-testid="body">{row.name}</div>}
    </DetailGate>,
  );
}

const loaded = { data: { name: "Design doc" }, isLoading: false, isError: false };

describe("DetailGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the row is in hand", () => {
    renderGate(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("Design doc");
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

  it("derives both messages from the noun", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(
      screen.getByText(/run the API server to load this work product\./),
    ).toBeInTheDocument();
  });

  it("echoes the id in the fetch-error message", () => {
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load work product")).toBeInTheDocument();
    expect(screen.getByText(/Work product wp_42 could not be fetched\./)).toBeInTheDocument();
  });

  // A query can settle without erroring and still hand back nothing (a 404
  // mapped to undefined). That has to land on the error state, not render
  // the body with a missing row.
  it("treats settled-but-empty as a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load work product")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // The nav is what gets the user off a page that failed to load, so it has
  // to survive every branch — not just the happy one.
  it("keeps the nav in the loading and error states", () => {
    const nav = <a href="/tasks">Back</a>;
    renderGate({ data: undefined, isLoading: true, isError: false }, nav).unmount();
    renderGate({ data: undefined, isLoading: false, isError: true }, nav);
    expect(screen.getByText("Back")).toBeInTheDocument();
  });
});
