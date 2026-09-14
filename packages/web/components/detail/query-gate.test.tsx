import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { QueryGate } from "./query-gate";

interface Row {
  name: string;
}

function renderGate(
  query: { data: Row | undefined; isLoading: boolean; isError: boolean },
  stateClassName?: string,
) {
  return render(
    <QueryGate
      noun="agent"
      id="agt_7"
      query={query}
      stateClassName={stateClassName}
      skeleton={<div data-testid="skeleton" />}
    >
      {(row) => <div data-testid="body">{row.name}</div>}
    </QueryGate>,
  );
}

const loaded = { data: { name: "Alice" }, isLoading: false, isError: false };

/**
 * The three-branch preamble itself. `detail-gate.test.tsx` covers the same
 * branches as seen through the full-page shell; these cover what pulling
 * the logic out of that shell added — the bare DOM the peek panels needed,
 * and the optional inset that let them stop hand-writing their own copies.
 */
describe("QueryGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders no shell of its own around the body", () => {
    const { container } = renderGate(loaded);
    expect(container.firstElementChild).toHaveAttribute("data-testid", "body");
  });

  it("insets the message states when asked", () => {
    apiState.isApiConfigured = false;
    const { container } = renderGate(
      { data: undefined, isLoading: false, isError: false },
      "p-4",
    );
    expect(container.firstElementChild).toHaveClass("p-4");
  });

  // DetailGate passes no stateClassName, and an empty wrapper div around the
  // EmptyState would be a gratuitous DOM change for the seven pages already
  // using it.
  it("omits the wrapper entirely when no inset is asked for", () => {
    apiState.isApiConfigured = false;
    const { container } = renderGate({ data: undefined, isLoading: false, isError: false });
    expect(container.querySelector("div[class='']")).toBeNull();
  });

  // The drift this replaced: the panels' hand-written copies had lost the
  // "and run the API server" half of this message.
  it("gives a panel the same wording the detail pages get", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false }, "p-4");
    expect(screen.getByText(/run the API server to load this agent\./)).toBeInTheDocument();
  });

  // …and had dropped the "Check the API server logs" hint entirely.
  it("echoes the id and the log hint on a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: true }, "p-4");
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(
      screen.getByText(/Agent agt_7 could not be fetched\. Check the API server logs\./),
    ).toBeInTheDocument();
  });

  it("leaves the skeleton unwrapped so it can carry its own padding", () => {
    const { container } = renderGate(
      { data: undefined, isLoading: true, isError: false },
      "p-4",
    );
    expect(container.firstElementChild).toHaveAttribute("data-testid", "skeleton");
  });

  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
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
