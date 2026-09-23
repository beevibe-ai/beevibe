import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { QueryGate, type GateFrame, type GateQuery } from "./query-gate";

interface Row {
  name: string;
}

function renderGate(
  query: GateQuery<Row>,
  overrides: { frame?: GateFrame; errorDetail?: string; notConfiguredTitle?: string } = {},
) {
  return render(
    <QueryGate
      noun="mesh activity"
      query={query}
      skeleton={<div data-testid="skeleton" />}
      {...overrides}
    >
      {(row: Row): ReactNode => <div data-testid="body">{row.name}</div>}
    </QueryGate>,
  );
}

const loaded: GateQuery<Row> = {
  data: { name: "12 asks" },
  isLoading: false,
  isError: false,
};
const loading: GateQuery<Row> = { data: undefined, isLoading: true, isError: false };
const failed: GateQuery<Row> = { data: undefined, isLoading: false, isError: true };

describe("QueryGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the data is in hand", () => {
    renderGate(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("12 asks");
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("renders the skeleton while loading, never the body", () => {
    renderGate(loading);
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // A page that never had a URL to call shouldn't accuse the server of
  // being down, so the unconfigured branch has to win over the error one.
  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderGate(failed);
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("derives both titles from the noun", () => {
    renderGate(failed);
    expect(screen.getByText("Couldn't load mesh activity")).toBeInTheDocument();

    apiState.isApiConfigured = false;
    renderGate(failed);
    expect(
      screen.getByText(/run the API server to load mesh activity\./),
    ).toBeInTheDocument();
  });

  it("lets a page keep its own not-configured title", () => {
    apiState.isApiConfigured = false;
    renderGate(failed, { notConfiguredTitle: "No mesh asks yet" });
    expect(screen.getByText("No mesh asks yet")).toBeInTheDocument();
  });

  // Several surfaces deliberately show a bare error title with no second
  // line, so an absent errorDetail must not render an empty paragraph.
  it("omits the error description when none is given", () => {
    const { container } = renderGate(failed);
    expect(container.textContent).toContain("Couldn't load mesh activity");
    expect(container.textContent).not.toContain("could not be fetched");

    renderGate(failed, { errorDetail: "Check that the API server is reachable." });
    expect(
      screen.getByText("Check that the API server is reachable."),
    ).toBeInTheDocument();
  });

  // A query can settle without erroring and still hand back nothing (a 404
  // mapped to undefined). That has to land on the error state, not render
  // the body with a missing row.
  it("treats settled-but-empty as a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load mesh activity")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  describe("frames", () => {
    it("puts the empty states in a dashed card by default", () => {
      const { container } = renderGate(failed);
      expect(container.querySelector(".border-dashed")).not.toBeNull();
    });

    it("pads them instead when the caller has its own shell", () => {
      const { container } = renderGate(failed, { frame: "pad" });
      expect(container.querySelector(".border-dashed")).toBeNull();
      expect(container.querySelector(".p-4")).not.toBeNull();
    });

    it("adds no chrome at all under frame=none", () => {
      const { container } = renderGate(failed, { frame: "none" });
      expect(container.querySelector(".border-dashed")).toBeNull();
      expect(container.querySelector(".p-4")).toBeNull();
    });

    // The frame belongs to the empty states only — a page owns the layout
    // of its own skeleton and body.
    it("never frames the skeleton or the body", () => {
      const skeleton = renderGate(loading);
      expect(skeleton.container.querySelector(".border-dashed")).toBeNull();
      skeleton.unmount();

      const body = renderGate(loaded);
      expect(body.container.querySelector(".border-dashed")).toBeNull();
    });
  });
});
