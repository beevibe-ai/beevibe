import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

const apiState = { isApiConfigured: true };

vi.mock("@/lib/api/config", () => ({
  get isApiConfigured() {
    return apiState.isApiConfigured;
  },
}));

vi.mock("@/lib/api/client", () => ({
  api: {
    tasks: { create: vi.fn() },
    agents: { list: vi.fn() },
  },
}));

import { CreateTaskDialog } from "./create-task-dialog";
import { api } from "@/lib/api/client";

const createMock = vi.mocked(api.tasks.create);
const listAgentsMock = vi.mocked(api.agents.list);

function renderDialog(props: { open: boolean; onClose: () => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<CreateTaskDialog {...props} />, { wrapper: Wrapper });
}

beforeEach(() => {
  apiState.isApiConfigured = true;
  createMock.mockReset();
  listAgentsMock.mockReset();
  listAgentsMock.mockResolvedValue([
    {
      id: "agt_a",
      name: "Alice",
      owner_id: "per_w",
      hierarchy_level: "ic" as const,
      created_at: new Date(),
      updated_at: new Date(),
      display_name: "Alice",
      hierarchy: "ic" as const,
    },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CreateTaskDialog", () => {
  it("returns null when closed", () => {
    renderDialog({ open: false, onClose: () => {} });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables submit when title is empty", () => {
    renderDialog({ open: true, onClose: () => {} });
    const submit = screen.getByRole("button", { name: /create task/i });
    expect(submit).toBeDisabled();
  });

  it("submits with the trimmed title and selected priority", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue({} as never);
    const onClose = vi.fn();
    renderDialog({ open: true, onClose });

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "  Wire kanban  " },
    });
    fireEvent.change(screen.getByLabelText(/priority/i), { target: { value: "high" } });
    await user.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock).toHaveBeenCalledWith({
      title: "Wire kanban",
      description: undefined,
      priority: "high",
      assignee_id: undefined,
      parent_task_id: undefined,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("forwards optional description, assignee, and parent_task_id", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue({} as never);
    renderDialog({ open: true, onClose: () => {}, defaultParentTaskId: "task_parent" } as never);
    await waitFor(() => expect(screen.getByText(/Alice/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "child" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "details" } });
    fireEvent.change(screen.getByLabelText(/assignee/i), { target: { value: "agt_a" } });
    await user.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock).toHaveBeenCalledWith({
      title: "child",
      description: "details",
      priority: "medium",
      assignee_id: "agt_a",
      parent_task_id: "task_parent",
    });
  });

  it("surfaces API errors and keeps the dialog open", async () => {
    const user = userEvent.setup();
    createMock.mockRejectedValue(new Error("server boom"));
    const onClose = vi.fn();
    renderDialog({ open: true, onClose });

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "x" } });
    await user.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() => expect(screen.getByText(/server boom/i)).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog({ open: true, onClose });
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
