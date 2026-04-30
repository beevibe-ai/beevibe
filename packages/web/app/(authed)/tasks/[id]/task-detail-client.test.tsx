import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TaskDetail } from "@/lib/api/types";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

vi.mock("@/lib/api/client", () => ({
  api: { tasks: { list: vi.fn(), get: vi.fn() } },
}));

import { TaskDetailClient } from "./task-detail-client";
import { api } from "@/lib/api/client";

const getMock = vi.mocked(api.tasks.get);

function renderDetail(taskId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<TaskDetailClient taskId={taskId} />, { wrapper: Wrapper });
}

function makeDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "t_abc",
    title: "Wire the Kanban",
    status: "review",
    priority: "high",
    creator_id: "u1",
    creator_type: "person",
    created_at: new Date("2026-04-25T00:00:00Z"),
    updated_at: new Date("2026-04-30T00:00:00Z"),
    work_products: [],
    sessions: [],
    ...overrides,
  };
}

beforeEach(() => {
  apiState.isApiConfigured = true;
  getMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TaskDetailClient", () => {
  it("renders the not-configured empty state and never fetches", () => {
    apiState.isApiConfigured = false;
    renderDetail("t_abc");
    expect(screen.getByText("API not configured")).toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("renders the error empty state and surfaces the task id when fetch fails", async () => {
    getMock.mockRejectedValue(new Error("boom"));
    renderDetail("t_abc");

    expect(await screen.findByText("Couldn't load task")).toBeInTheDocument();
    expect(screen.getByText(/Task t_abc could not be fetched/)).toBeInTheDocument();
  });

  it("renders the loaded task with title, status, and footer fields", async () => {
    getMock.mockResolvedValue(
      makeDetail({
        title: "Wire the Kanban",
        status: "review",
        priority: "high",
        assignee_label: "alice",
      }),
    );
    renderDetail("t_abc");

    expect(await screen.findByRole("heading", { name: "Wire the Kanban" })).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("shows the Approve / Reject / Request revision actions when status is review", async () => {
    getMock.mockResolvedValue(makeDetail({ status: "review" }));
    renderDetail("t_abc");

    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeInTheDocument();
  });

  it("hides the Approve action when status is not review", async () => {
    getMock.mockResolvedValue(makeDetail({ status: "in_progress" }));
    renderDetail("t_abc");

    await waitFor(() => expect(screen.queryByText("review")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("renders the blocked rail when status=blocked with a reason", async () => {
    getMock.mockResolvedValue(
      makeDetail({
        status: "blocked",
        blocker_reason: "needs API key from alice",
      }),
    );
    renderDetail("t_abc");

    expect(await screen.findByText("needs API key from alice")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Blocked" })).toBeInTheDocument();
  });

  it("renders an Active session rail when latest_session is running", async () => {
    getMock.mockResolvedValue(
      makeDetail({
        latest_session: {
          short_id: "s_xyz",
          status: "running",
          elapsed: "2m",
          agent_label: "executor",
        },
      }),
    );
    renderDetail("t_abc");

    expect(await screen.findByRole("heading", { name: "Active session" })).toBeInTheDocument();
    expect(screen.getByText("s_xyz")).toBeInTheDocument();
    expect(screen.getByText(/executor · 2m/)).toBeInTheDocument();
  });
});
