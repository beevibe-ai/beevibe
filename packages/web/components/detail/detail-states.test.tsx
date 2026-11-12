import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { DetailStates } from "./detail-states";

interface Row {
  name: string;
}

function renderStates(
  query: { data: Row | undefined; isLoading: boolean; isError: boolean },
  messageClassName?: string,
) {
  return render(
    <DetailStates
      noun="agent"
      id="agent_7"
      query={query}
      messageClassName={messageClassName}
      skeleton={<div data-testid="skeleton" />}
    >
      {(row) => <div data-testid="body">{row.name}</div>}
    </DetailStates>,
  );
}

const loaded = { data: { name: "Ada" }, isLoading: false, isError: false };

describe("DetailStates", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the row is in hand", () => {
    renderStates(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("Ada");
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("renders the skeleton while loading, never the body", () => {
    renderStates({ data: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("reports an unconfigured API before it reports a failed fetch", () => {
    apiState.isApiConfigured = false;
    renderStates({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("derives both messages from the noun", () => {
    renderStates({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(screen.getByText(/Agent agent_7 could not be fetched\./)).toBeInTheDocument();
  });

  // Same 404-mapped-to-undefined case the gate guards: a settled query with
  // no row must land on the error branch, not render a body without data.
  it("treats settled-but-empty as a failed fetch", () => {
    renderStates({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText("Couldn't load agent")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // This is what makes the component reusable inside PeekPanel: a page
  // inherits padding from DetailShell and passes nothing, while the peek
  // panels own their padding and pass it in. Neither gets the other's.
  it("wraps the message branches only when given a class", () => {
    const { container, unmount } = renderStates(
      { data: undefined, isLoading: false, isError: true },
      "p-4",
    );
    expect(container.querySelector(".p-4")).not.toBeNull();
    unmount();

    const bare = renderStates({ data: undefined, isLoading: false, isError: true });
    expect(bare.container.querySelector(".p-4")).toBeNull();
  });

  // The loading branch hands back the caller's skeleton untouched — the
  // panels bake their own padding into it, so an extra wrapper here would
  // double it.
  it("never wraps the skeleton", () => {
    const { container } = renderStates(
      { data: undefined, isLoading: true, isError: false },
      "p-4",
    );
    expect(container.querySelector(".p-4")).toBeNull();
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
  });
});
