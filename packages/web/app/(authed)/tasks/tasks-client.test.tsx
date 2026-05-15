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

// TasksClient reads router/search params for the side-panel ?p= state.
// The panel only mounts when `?p=` is set; default search params are
// empty here so the panel stays closed across these tests.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/tasks",
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

  // Regression: previously, navigating /chat → /tasks after an SSE
  // invalidation that marked a cached `[]` as stale would briefly flash
  // the "No tasks yet" empty state until the background refetch settled
  // (typically ~200ms). User perception: "the task didn't show up; I
  // had to refresh." Hard refresh worked because isLoading=true on
  // initial mount correctly suppresses the empty state. Background
  // refetches on a stale-empty cache had isLoading=false and so fell
  // through to the misleading empty state.
  it("does NOT render the no-results empty state while a background refetch is in flight on a stale-empty cache", async () => {
    // Resolver we control so the refetch stays in-flight while we
    // assert. This is the window the bug-fix targets.
    let resolveRefetch: (tasks: TaskListItem[]) => void = () => {};
    listMock.mockImplementation(
      () => new Promise((resolve) => { resolveRefetch = resolve; }),
    );

    // Pre-seed the cache as if a previous /tasks visit returned [], then
    // invalidate it to simulate the SSE task.created handler. This puts
    // useTasks in the exact state we want on mount: cached empty data,
    // stale, refetch about to fire.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["tasks", "list", {}], []);
    await client.invalidateQueries({ queryKey: ["tasks"] });

    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    render(<TasksClient />, { wrapper: Wrapper });

    // Refetch is in flight. With the bug, "No tasks yet" would be in
    // the DOM right now. With the fix, isFetching=true suppresses it.
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();

    // Refetch settles with a real task — the lane shows the task and
    // the empty state stays absent.
    resolveRefetch([makeTask({ id: "new1", status: "in_progress", title: "freshly minted" })]);
    expect(await screen.findByText("freshly minted")).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
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
  it("groups returned tasks into the five lifecycle columns with counts", async () => {
    listMock.mockResolvedValue([
      makeTask({ id: "p1", status: "pending", title: "p one" }),
      makeTask({ id: "p2", status: "assigned", title: "p two" }),
      makeTask({ id: "ip1", status: "in_progress", title: "ip one" }),
      makeTask({ id: "blk1", status: "blocked", title: "blocked one" }),
      makeTask({ id: "rev1", status: "review", title: "review one" }),
      makeTask({ id: "d1", status: "done", title: "done one" }),
    ]);
    renderClient();

    expect(await screen.findByText("p one")).toBeInTheDocument();

    const counts = ["Pending", "In progress", "Blocked", "In review", "Done"].map(
      (label) => {
        // The "Blocked" column header collides with the per-card
        // blocker tone class — getAllByText returns multiple, so we
        // pick the first and traverse to its tabular-nums sibling.
        // For unique headers (single match) this still works.
        const lane = screen.getAllByText(label)[0];
        const countNode = lane.parentElement?.querySelector(".tabular-nums");
        return countNode?.textContent;
      },
    );
    expect(counts).toEqual(["2", "1", "1", "1", "1"]);
  });

  it("hides cancelled+failed by default and surfaces the archive toggle", async () => {
    listMock.mockResolvedValue([
      makeTask({ id: "d1", status: "done", title: "done one" }),
      makeTask({ id: "f1", status: "failed", title: "failed one" }),
      makeTask({ id: "c1", status: "cancelled", title: "cancel one" }),
    ]);
    renderClient();

    expect(await screen.findByText("done one")).toBeInTheDocument();
    // Failed + cancelled are off by default.
    expect(screen.queryByText("failed one")).not.toBeInTheDocument();
    expect(screen.queryByText("cancel one")).not.toBeInTheDocument();
    // Toggle pill exposes the count. Accessible name = its text
    // content ("2 archived") since the button has no aria-label.
    const toggle = screen.getByRole("button", { name: /\d+ archived/i });
    expect(toggle).toHaveTextContent("2 archived");
    // Click expands the Archived lane.
    await userEvent.click(toggle);
    expect(await screen.findByText("failed one")).toBeInTheDocument();
    expect(screen.getByText("cancel one")).toBeInTheDocument();
  });

  it("calls the task list endpoint without a view filter (no My tasks tab)", async () => {
    listMock.mockResolvedValue([]);
    renderClient();

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({}, expect.objectContaining({})),
    );
    // Sanity: the obsolete "My tasks" affordance shouldn't render.
    expect(screen.queryByRole("button", { name: "My tasks" })).not.toBeInTheDocument();
  });
});
