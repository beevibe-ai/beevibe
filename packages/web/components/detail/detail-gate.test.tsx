import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { DetailGate, peekPanelShell } from "./detail-gate";

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

describe("DetailGate shell", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  function renderWithShell(query: {
    data: Row | undefined;
    isLoading: boolean;
    isError: boolean;
  }) {
    return render(
      <DetailGate
        noun="agent"
        id="agent_7"
        query={query}
        skeleton={<div data-testid="skeleton" />}
        shell={(content, branch) => <div data-testid={`shell-${branch}`}>{content}</div>}
      >
        {(row) => <div data-testid="body">{row.name}</div>}
      </DetailGate>,
    );
  }

  it("replaces DetailShell entirely when given", () => {
    // The peek panels' chrome is `PeekPanel`, a level above — a DetailShell
    // inside one would add a second centered column.
    const { container } = renderWithShell(loaded);
    expect(screen.getByTestId("shell-ready")).toContainElement(screen.getByTestId("body"));
    expect(container.querySelector(".max-w-5xl")).toBeNull();
  });

  it("names the branch so a caller can wrap only the ones it wants", () => {
    renderWithShell({ data: undefined, isLoading: true, isError: false }).unmount();
    expect(screen.queryByTestId("shell-loading")).toBeNull();

    renderWithShell({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("shell-loading")).toContainElement(
      screen.getByTestId("skeleton"),
    );
  });

  it("wraps the unconfigured and error branches too", () => {
    apiState.isApiConfigured = false;
    renderWithShell({ data: undefined, isLoading: false, isError: false }).unmount();
    apiState.isApiConfigured = true;

    renderWithShell({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByTestId("shell-error")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
  });

  it("still derives the copy from the noun, so a panel can't word it its own way", () => {
    // The whole point of the panels adopting this: they had drifted to
    // "Set NEXT_PUBLIC_BV_API_URL to load this agent." with no mention of
    // running the server, and dropped the "Check the API server logs." hint.
    apiState.isApiConfigured = false;
    renderWithShell({ data: undefined, isLoading: false, isError: false });
    expect(
      screen.getByText(/run the API server to load this agent\./),
    ).toBeInTheDocument();
  });
});

describe("peekPanelShell", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  function renderPeek(query: {
    data: Row | undefined;
    isLoading: boolean;
    isError: boolean;
  }) {
    return render(
      <DetailGate
        noun="task"
        id="t_9"
        query={query}
        skeleton={<div data-testid="skeleton" />}
        shell={peekPanelShell}
      >
        {(row) => <div data-testid="body">{row.name}</div>}
      </DetailGate>,
    );
  }

  it("hands the loaded body through unpadded", () => {
    // `PanelLoaded` sets its own `px-5 py-5`; a wrapper here would double it.
    const { container } = renderPeek(loaded);
    expect(container.querySelector(".p-4")).toBeNull();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("hands the skeleton through unpadded", () => {
    // The panels' skeletons carry `p-5 space-y-4` themselves.
    const { container } = renderPeek({ data: undefined, isLoading: true, isError: false });
    expect(container.querySelector(".p-4")).toBeNull();
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
  });

  it("pads the error state", () => {
    const { container } = renderPeek({ data: undefined, isLoading: false, isError: true });
    expect(container.querySelector(".p-4")).not.toBeNull();
  });

  it("pads the unconfigured state", () => {
    apiState.isApiConfigured = false;
    const { container } = renderPeek({ data: undefined, isLoading: false, isError: false });
    expect(container.querySelector(".p-4")).not.toBeNull();
  });
});
