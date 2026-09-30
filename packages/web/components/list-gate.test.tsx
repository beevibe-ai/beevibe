import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Network } from "lucide-react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

import { EmptyPanel, ListGate } from "./list-gate";
import { ApiError } from "@/lib/api/http";

interface Row {
  name: string;
}

function renderGate(query: {
  data: Row[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
}) {
  return render(
    <ListGate
      icon={Network}
      noun="mesh activity"
      query={query}
      skeleton={<div data-testid="skeleton" />}
    >
      {(rows) => <div data-testid="body">{rows.length} rows</div>}
    </ListGate>,
  );
}

const loaded = { data: [{ name: "a" }], isLoading: false, isError: false };

describe("ListGate", () => {
  beforeEach(() => {
    apiState.isApiConfigured = true;
  });

  it("renders the body once the rows are in hand", () => {
    renderGate(loaded);
    expect(screen.getByTestId("body")).toHaveTextContent("1 rows");
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("hands an empty list through to the body rather than claiming a failure", () => {
    renderGate({ data: [], isLoading: false, isError: false });
    expect(screen.getByTestId("body")).toHaveTextContent("0 rows");
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

  // The pages this replaced variously said "run the API server", "run the
  // MCP server" and "Check that the MCP server is reachable" for one
  // process. Both messages are derived from `noun` so a page can't word
  // them a fourth way.
  it("derives both messages from the noun", () => {
    apiState.isApiConfigured = false;
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByText(/run the API server to load mesh activity\./)).toBeInTheDocument();
  });

  it("surfaces the server's own message on a failed fetch", () => {
    renderGate({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError("HTTP 500", 500, { error: "boom", message: "mesh resolver timed out" }),
    });
    expect(screen.getByText("Couldn't load mesh activity")).toBeInTheDocument();
    expect(screen.getByText("mesh resolver timed out")).toBeInTheDocument();
  });

  it("falls back to a generic hint when the page passes no error", () => {
    renderGate({ data: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Check that the API server is reachable.")).toBeInTheDocument();
  });

  // Unreachable in practice (the query is `enabled: isApiConfigured`, which
  // the first branch already returned for), but it must not fall through to
  // `children` with an undefined list.
  it("shows the skeleton rather than the body when a settled query has no data", () => {
    renderGate({ data: undefined, isLoading: false, isError: false });
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("body")).toBeNull();
  });
});

describe("EmptyPanel", () => {
  it("frames the empty state in the dashed card and appends extra classes", () => {
    const { container } = render(
      <EmptyPanel title="No promotions yet" description="Nothing yet." className="max-w-md" />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("border-dashed");
    expect(card.className).toContain("max-w-md");
    expect(screen.getByText("No promotions yet")).toBeInTheDocument();
  });
});
