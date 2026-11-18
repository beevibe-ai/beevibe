import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

vi.mock("@/lib/api/client", () => ({
  api: { learnedSkills: { create: vi.fn() } },
}));

import { SaveCapabilityModal } from "./save-capability-modal";
import { api } from "@/lib/api/client";

const createMock = vi.mocked(api.learnedSkills.create);

function renderModal(props: Partial<Parameters<typeof SaveCapabilityModal>[0]> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    <SaveCapabilityModal
      repoRunId="rr_1"
      initialName="extract-tables"
      initialGoal="extract tables from a PDF"
      onClose={onClose}
      {...props}
    />,
    { wrapper: Wrapper },
  );
  return { onClose };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("SaveCapabilityModal", () => {
  it("seeds both fields from the initial props", () => {
    renderModal();
    expect(screen.getByLabelText("Capability name")).toHaveValue("extract-tables");
    expect(screen.getByLabelText("Goal pattern")).toHaveValue(
      "extract tables from a PDF",
    );
  });

  it("posts the edited name + goal against the run id, then shows the saved state", async () => {
    createMock.mockResolvedValue({ skill: {} } as never);
    renderModal();

    const name = screen.getByLabelText("Capability name");
    await userEvent.clear(name);
    await userEvent.type(name, "pdf-tables");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: "pdf-tables",
        goal_pattern: "extract tables from a PDF",
        repo_run_id: "rr_1",
      }),
    );
    // Success swaps the form out for the confirmation + deep link, which is
    // what tells the user the capability is now discoverable by find_repo.
    await screen.findByText("pdf-tables");
    expect(screen.getByRole("link", { name: /View in Capabilities/ })).toHaveAttribute(
      "href",
      "/capabilities",
    );
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("surfaces the failure message and keeps the form up", async () => {
    createMock.mockRejectedValue(new Error("name already taken"));
    renderModal();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("name already taken");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("offers the agent-summary swap only when one is supplied and differs", async () => {
    renderModal({ summaryPattern: "pull every table out of a PDF" });
    await userEvent.click(screen.getByRole("button", { name: /Use agent's summary/ }));
    expect(screen.getByLabelText("Goal pattern")).toHaveValue(
      "pull every table out of a PDF",
    );
    // Once taken, the draft equals the suggestion, so the affordance retires.
    expect(screen.queryByRole("button", { name: /Use agent's summary/ })).toBeNull();
  });

  it("hides the summary swap when no summary pattern is given", () => {
    renderModal();
    expect(screen.queryByRole("button", { name: /Use agent's summary/ })).toBeNull();
  });

  it("closes on Cancel without posting anything", async () => {
    const { onClose } = renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});
