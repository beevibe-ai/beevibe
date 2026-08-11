import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { DetailGate } from "./detail-gate";
import { PanelGate } from "./panel-gate";

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

// The whole point of hoisting `gateCopy` out of DetailGate is that the panel
// and the full route can't word the same condition differently again. Assert
// the two gates agree rather than trusting that nobody edits one in isolation.
describe("PanelGate / DetailGate copy", () => {
  const empty = { data: undefined, isLoading: false, isError: true };

  function textsFrom(node: HTMLElement): string[] {
    return Array.from(node.querySelectorAll("p")).map((p) => p.textContent ?? "");
  }

  it("words the fetch error identically", () => {
    const panel = render(
      <PanelGate noun="task" id="task_42" query={empty} skeleton={null}>
        {() => null}
      </PanelGate>,
    );
    const panelText = textsFrom(panel.container);
    panel.unmount();
    // Guard against the comparison passing because both sides rendered nothing.
    expect(panelText).toContain("Couldn't load task");

    const detail = render(
      <DetailGate noun="task" id="task_42" query={empty} skeleton={null}>
        {() => null}
      </DetailGate>,
    );
    expect(textsFrom(detail.container)).toEqual(panelText);
  });

  it("words the unconfigured-API message identically", () => {
    apiState.isApiConfigured = false;
    const panel = render(
      <PanelGate noun="task" id="task_42" query={empty} skeleton={null}>
        {() => null}
      </PanelGate>,
    );
    const panelText = textsFrom(panel.container);
    panel.unmount();
    expect(panelText).toContain("API not configured");

    const detail = render(
      <DetailGate noun="task" id="task_42" query={empty} skeleton={null}>
        {() => null}
      </DetailGate>,
    );
    expect(textsFrom(detail.container)).toEqual(panelText);
    apiState.isApiConfigured = true;
  });
});
