import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { PanelGate } from "./peek-panel";

interface Row {
  name: string;
}

function renderGate(query: { data: Row | undefined; isLoading: boolean; isError: boolean }) {
  return render(
    <PanelGate noun="task" id="task_42" query={query} skeleton={<div data-testid="skeleton" />}>
      {(row) => <div data-testid="body">{row.name}</div>}
    </PanelGate>,
  );
}

describe("PanelGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the row is in hand", () => {
    renderGate({ data: { name: "Ship it" }, isLoading: false, isError: false });
    expect(screen.getByTestId("body")).toHaveTextContent("Ship it");
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
    expect(screen.getByText(/to load this task\./)).toBeInTheDocument();
  });

  it("echoes the id in the fetch-error message", () => {
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load task")).toBeInTheDocument();
    expect(screen.getByText(/Task task_42 could not be fetched\./)).toBeInTheDocument();
  });

  // A query can settle without erroring and still hand back nothing (a 404
  // mapped to undefined). That has to land on the error state, not render
  // the body with a missing row.
  it("treats settled-but-empty as a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load task")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});
