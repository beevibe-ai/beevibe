import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";

vi.mock("@/lib/api/client", () => ({
  api: {
    tasks: {
      approve: vi.fn(),
      reject: vi.fn(),
      revise: vi.fn(),
    },
  },
}));

import { TaskReviewActions, useTaskReview } from "./task-review-actions";
import { api } from "@/lib/api/client";

const approveMock = vi.mocked(api.tasks.approve);
const rejectMock = vi.mocked(api.tasks.reject);
const reviseMock = vi.mocked(api.tasks.revise);

/**
 * Renders the hook + component the way both real surfaces do. `variant`
 * is the only thing the page and the panel disagree on, so each test
 * runs against whichever variant exercises the branch.
 */
function Harness({ variant }: { variant: "page" | "panel" }) {
  const review = useTaskReview("t_abc");
  return <TaskReviewActions review={review} variant={variant} />;
}

function renderActions(variant: "page" | "panel" = "page") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<Harness variant={variant} />, { wrapper: Wrapper });
}

beforeEach(() => {
  approveMock.mockReset();
  rejectMock.mockReset();
  reviseMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TaskReviewActions", () => {
  it("renders all three actions, with the page's long revise label", () => {
    renderActions("page");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeInTheDocument();
  });

  it("shortens the revise label in the panel, which has no room for it", () => {
    renderActions("panel");
    expect(screen.getByRole("button", { name: "Revise" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request revision" })).toBeNull();
  });

  it("approves with an empty body", async () => {
    approveMock.mockResolvedValue(undefined as never);
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith("t_abc", {}));
  });

  it("rejects with an empty body", async () => {
    rejectMock.mockResolvedValue(undefined as never);
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(rejectMock).toHaveBeenCalledWith("t_abc", {}));
  });

  it("keeps the revise drawer shut until the button is pressed", async () => {
    renderActions();
    expect(screen.queryByPlaceholderText("What needs to change?")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Request revision" }));
    expect(screen.getByPlaceholderText("What needs to change?")).toBeInTheDocument();
  });

  it("disables submit until the feedback has non-whitespace content", async () => {
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Request revision" }));
    const submit = screen.getByRole("button", { name: "Submit revision" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText("What needs to change?"), "   ");
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText("What needs to change?"), "tighten the copy");
    expect(submit).toBeEnabled();
  });

  it("submits trimmed feedback, then clears and closes the drawer", async () => {
    reviseMock.mockResolvedValue(undefined as never);
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Request revision" }));
    await userEvent.type(
      screen.getByPlaceholderText("What needs to change?"),
      "  tighten the copy  ",
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit revision" }));

    await waitFor(() =>
      expect(reviseMock).toHaveBeenCalledWith("t_abc", { feedback: "tighten the copy" }),
    );
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("What needs to change?")).toBeNull(),
    );
  });

  it("drops the feedback and shuts the drawer on Cancel, without calling the api", async () => {
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Request revision" }));
    await userEvent.type(screen.getByPlaceholderText("What needs to change?"), "never mind");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByPlaceholderText("What needs to change?")).toBeNull();
    expect(reviseMock).not.toHaveBeenCalled();

    // Reopening starts blank — the draft is dropped, not stashed.
    await userEvent.click(screen.getByRole("button", { name: "Request revision" }));
    expect(screen.getByPlaceholderText("What needs to change?")).toHaveValue("");
  });

  it("names the failed action in the error, not just that something failed", async () => {
    approveMock.mockRejectedValue(new Error("409 conflict"));
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Couldn't approve: 409 conflict/)).toBeInTheDocument();
  });

  it("gates every action while one is in flight", async () => {
    let release: () => void = () => {};
    approveMock.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(undefined as never); }),
    );
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();

    release();
  });
});
