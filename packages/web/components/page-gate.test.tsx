import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { EmptyCard, PageGate } from "./page-gate";

interface Row {
  name: string;
}

function renderGate(query: { data: Row | undefined; isLoading: boolean; isError: boolean }) {
  return render(
    <PageGate
      query={query}
      notConfigured={{ title: "Nothing here yet", description: "Set NEXT_PUBLIC_BV_API_URL." }}
      error={{ title: "Couldn't load rows", description: "Check the API server." }}
      skeleton={<div data-testid="skeleton" />}
    >
      {(row) => <div data-testid="body">{row.name}</div>}
    </PageGate>,
  );
}

describe("PageGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the data is in hand", () => {
    renderGate({ data: { name: "Design doc" }, isLoading: false, isError: false });
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
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("never fires the body when the API is unconfigured, even with cached data", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: { name: "stale" }, isLoading: false, isError: false });
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("shows the error state on a failed fetch", () => {
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load rows")).toBeInTheDocument();
    expect(screen.getByText("Check the API server.")).toBeInTheDocument();
  });

  // A background refetch can fail while stale data is still cached. Every
  // page this replaced checked `isError` before rendering content, so the
  // error state wins over the stale rows rather than silently showing them.
  it("prefers the error state over stale cached data", () => {
    renderGate({ data: { name: "stale" }, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load rows")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  // Unlike DetailGate — where a settled-but-empty query means a 404 — a list
  // query that has not produced data yet is still pre-first-fetch, and the
  // pages this replaced showed their skeleton for it.
  it("treats settled-but-empty as still loading", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});

describe("EmptyCard", () => {
  it("frames the empty state in the dashed card and keeps extra classes", () => {
    const { container } = render(
      <EmptyCard title="No promotions yet" className="w-full max-w-md" />,
    );
    const card = container.firstElementChild;
    expect(card).toHaveClass("border-dashed", "max-w-md");
    expect(screen.getByText("No promotions yet")).toBeInTheDocument();
  });

  it("passes the cta through", () => {
    render(<EmptyCard title="No mesh asks yet" cta={{ href: "/", label: "Open chat" }} />);
    expect(screen.getByRole("link", { name: /Open chat/ })).toHaveAttribute("href", "/");
  });
});
