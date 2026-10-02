import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { PageGate } from "./page-gate";

type Rows = string[];

function renderGate(
  query: { data: Rows | undefined; isLoading: boolean; isError: boolean },
  extra: { errorDescription?: string; target?: string } = {},
) {
  return render(
    <PageGate
      noun="promotions"
      query={query}
      skeleton={<div data-testid="skeleton" />}
      {...extra}
    >
      {(rows) => <div data-testid="body">{rows.join(",")}</div>}
    </PageGate>,
  );
}

const loaded = { data: ["a", "b"], isLoading: false, isError: false };

describe("PageGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the rows are in hand", () => {
    renderGate(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("a,b");
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
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load promotions")).toBeInTheDocument();
    expect(screen.getByText(/Promotions could not be fetched\./)).toBeInTheDocument();
  });

  it("uses `target` for the sentence and `noun` for the title", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false }, {
      target: "the promotion log",
    });
    expect(
      screen.getByText(/run the API server to load the promotion log\./),
    ).toBeInTheDocument();
  });

  it("prefers an explicit errorDescription over the derived one", () => {
    renderGate({ data: undefined, isLoading: false, isError: true }, {
      errorDescription: "503 Service Unavailable",
    });
    expect(screen.getByText("Couldn't load promotions")).toBeInTheDocument();
    expect(screen.getByText("503 Service Unavailable")).toBeInTheDocument();
  });

  // An overview page's query can settle with nothing while a refetch is in
  // flight. Unlike DetailGate — where a missing row IS the error — holding
  // the skeleton is right here, because an empty list is the page's own
  // state to render, not a failure.
  it("holds the skeleton on a settled-but-empty query rather than erroring", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("hands an empty array through to the body, not the skeleton", () => {
    renderGate({ data: [], isLoading: false, isError: false });
    expect(screen.getByTestId("body")).toBeInTheDocument();
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });
});
