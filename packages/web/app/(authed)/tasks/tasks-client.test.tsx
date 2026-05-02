import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { TaskListItem } from "@/lib/types/tasks";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

vi.mock("@/lib/api/client", () => ({
  api: {
    tasks: {
      list: vi.fn(),
      get: vi.fn(),
    },
  },
}));

import { TasksClient } from "./tasks-client";
import { api } from "@/lib/api/client";

const listMock = vi.mocked(api.tasks.list);

function renderClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<TasksClient />, { wrapper: Wrapper });
}

function makeTask(overrides: Partial<TaskListItem>): TaskListItem {
  return {
    id: "t1",
    title: "default",
    status: "in_progress",
    priority: "medium",
    creator_id: "u1",
    creator_type: "person",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  apiState.isApiConfigured = true;
  listMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TasksClient — empty-state branches", () => {
  it("renders the not-configured empty state when env is unset (and never calls api)", async () => {
    apiState.isApiConfigured = false;
    renderClient();

    expect(await screen.findByText("No tasks yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Set NEXT_PUBLIC_BV_API_URL and run the MCP server/i),
    ).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("renders the error empty state when the api throws", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    renderClient();

    expect(await screen.findByText("Couldn't load tasks")).toBeInTheDocument();
  });

  it("renders the no-results empty state when api returns []", async () => {
    listMock.mockResolvedValue([]);
    renderClient();

    expect(await screen.findByText("No tasks yet")).toBeInTheDocument();
    expect(
      screen.getByText(/talking to your team agent/i),
    ).toBeInTheDocument();
  });

  it("renders the no-matching-search empty state when query has no matches", async () => {
    listMock.mockResolvedValue([makeTask({ title: "alpha" }), makeTask({ id: "t2", title: "beta" })]);
    renderClient();

    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const search = screen.getByRole("searchbox", { name: /search tasks/i });
    await userEvent.type(search, "zeta");

    expect(await screen.findByText("No matching tasks")).toBeInTheDocument();
    expect(screen.getByText(/Try a different search/i)).toBeInTheDocument();
  });
});

describe("TasksClient — lane rendering", () => {
  it("groups returned tasks into the four lifecycle columns with counts", async () => {
    listMock.mockResolvedValue([
      makeTask({ id: "p1", status: "pending", title: "p one" }),
      makeTask({ id: "p2", status: "assigned", title: "p two" }),
      makeTask({ id: "ip1", status: "in_progress", title: "ip one" }),
      makeTask({ id: "rev1", status: "review", title: "review one" }),
      makeTask({ id: "rev2", status: "blocked", title: "review two" }),
      makeTask({ id: "d1", status: "done", title: "done one" }),
    ]);
    renderClient();

    expect(await screen.findByText("p one")).toBeInTheDocument();

    const counts = ["Pending", "In progress", "In review", "Done"].map((label) => {
      const lane = screen.getByText(label);
      const countNode = lane.parentElement?.querySelector(".tabular-nums");
      return countNode?.textContent;
    });
    expect(counts).toEqual(["2", "1", "2", "1"]);
  });

  it("re-fetches with new view filter when a tab is clicked", async () => {
    listMock.mockResolvedValue([]);
    renderClient();

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({}, expect.objectContaining({})),
    );

    await userEvent.click(screen.getByRole("button", { name: "My tasks" }));

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({ view: "mine" }, expect.objectContaining({})),
    );
  });
});
