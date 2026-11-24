import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Network } from "lucide-react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { QueryGate } from "./query-gate";

type Rows = string[];

interface GateQuery {
  data: Rows | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
}

function renderGate(query: GateQuery, extra: Record<string, unknown> = {}) {
  return render(
    <QueryGate<Rows>
      icon={Network}
      noun="mesh activity"
      query={query}
      skeleton={<div data-testid="skeleton" />}
      {...extra}
    >
      {(rows) => <div data-testid="body">{rows.join(",")}</div>}
    </QueryGate>,
  );
}

const loaded: GateQuery = { data: ["a", "b"], isLoading: false, isError: false, error: null };
const loading: GateQuery = { data: undefined, isLoading: true, isError: false, error: null };
const failed: GateQuery = { data: undefined, isLoading: false, isError: true, error: null };

describe("QueryGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the rows are in hand", () => {
    renderGate(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("a,b");
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("renders the skeleton while loading, never the body", () => {
    renderGate(loading);
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // With no base URL the request cannot have been made, so "couldn't load"
  // would point the user at the wrong problem.
  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderGate(failed);
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("derives both messages from the noun", () => {
    apiState.isApiConfigured = false;
    renderGate(loading);
    expect(
      screen.getByText(/run the API server to load mesh activity\./),
    ).toBeInTheDocument();

    apiState.isApiConfigured = true;
    renderGate(failed);
    expect(screen.getByText("Couldn't load mesh activity")).toBeInTheDocument();
  });

  it("lets a page title the unconfigured branch itself", () => {
    apiState.isApiConfigured = false;
    renderGate(loading, { unconfiguredTitle: "No mesh asks yet" });
    expect(screen.getByText("No mesh asks yet")).toBeInTheDocument();
    expect(screen.queryByText("API not configured")).toBeNull();
  });

  // react-query reports `error: null` on the success path, so the failure
  // branch has to test for truthiness — keying off the property's presence
  // rendered the string "null" as the description.
  it("falls back to the generic hint when the query carries no error value", () => {
    renderGate(failed);
    expect(screen.getByText("Check that the API server is reachable.")).toBeInTheDocument();
  });

  it("surfaces the error's own message when there is one", () => {
    renderGate({ ...failed, error: new Error("ECONNREFUSED 127.0.0.1:3000") });
    expect(screen.getByText("ECONNREFUSED 127.0.0.1:3000")).toBeInTheDocument();
    expect(screen.queryByText("Check that the API server is reachable.")).toBeNull();
  });

  // A query can settle without erroring and still hand back nothing (a 404
  // mapped to undefined). That has to land on the error state, not render
  // the body with a missing payload.
  it("treats settled-but-dataless as a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: false, error: null });
    expect(screen.getByText("Couldn't load mesh activity")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("shows the empty copy when the fetch settled with no rows", () => {
    renderGate({ data: [], isLoading: false, isError: false, error: null }, {
      empty: { title: "No mesh asks yet", description: "Agents haven't asked each other yet." },
    });
    expect(screen.getByText("No mesh asks yet")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // A page whose content component renders its own zero-row state passes no
  // `empty`; the gate must hand the empty array through rather than swallow it.
  it("renders the body for an empty payload when no empty copy is given", () => {
    renderGate({ data: [], isLoading: false, isError: false, error: null });
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("honours a custom isEmpty for payloads that aren't arrays", () => {
    render(
      <QueryGate<{ daemons: string[] }>
        noun="runtimes"
        query={{ data: { daemons: [] }, isLoading: false, isError: false, error: null }}
        skeleton={<div />}
        isEmpty={(d) => d.daemons.length === 0}
        empty={{ title: "No daemons yet" }}
      >
        {() => <div data-testid="body" />}
      </QueryGate>,
    );
    expect(screen.getByText("No daemons yet")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("wraps the non-content branches in the frame the page supplies", () => {
    apiState.isApiConfigured = false;
    renderGate(loading, {
      frame: (node: React.ReactNode) => <div data-testid="frame">{node}</div>,
    });
    expect(screen.getByTestId("frame")).toBeInTheDocument();
  });

  // The frame is for the gate's own cards; content must not inherit it, or
  // every loaded page would gain a stray dashed border.
  it("does not apply the frame to loaded content", () => {
    renderGate(loaded, {
      frame: (node: React.ReactNode) => <div data-testid="frame">{node}</div>,
    });
    expect(screen.queryByTestId("frame")).toBeNull();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });
});
