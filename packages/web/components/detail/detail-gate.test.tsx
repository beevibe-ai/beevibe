import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { DetailGate, PanelGate } from "./detail-gate";

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

function renderPanel(query: {
  data: Row | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  return render(
    <PanelGate
      noun="work product"
      id="wp_42"
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

  it("renders the body once the row is in hand, unwrapped", () => {
    const { container } = renderPanel(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("Design doc");
    // No padding wrapper around the loaded body — PanelLoaded owns its own
    // `px-5 py-5`, so a second one here would double the gutter.
    expect(container.firstElementChild).toBe(screen.getByTestId("body"));
  });

  it("renders the skeleton while loading, never the body", () => {
    renderPanel({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // The whole point of routing the panels through the shared gate: they used
  // to word these two states differently from the pages.
  it("words both messages exactly as DetailGate does", () => {
    apiState.isApiConfigured = false;
    const unconfigured = renderPanel({ data: undefined, isLoading: false, isError: false });
    expect(
      screen.getByText(/run the API server to load this work product\./),
    ).toBeInTheDocument();
    unconfigured.unmount();

    apiState.isApiConfigured = true;
    renderPanel({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load work product")).toBeInTheDocument();
    expect(
      screen.getByText(/Work product wp_42 could not be fetched\. Check the API server logs\./),
    ).toBeInTheDocument();
  });

  it("treats settled-but-empty as a failed fetch", () => {
    renderPanel({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load work product")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});
