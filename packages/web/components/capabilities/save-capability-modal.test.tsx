import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const create = vi.fn();
vi.mock("@/lib/api/client", () => ({
  api: { learnedSkills: { create: (input: unknown) => create(input) } },
}));

import { SaveCapabilityModal } from "./save-capability-modal";

function renderModal(props: Partial<Parameters<typeof SaveCapabilityModal>[0]> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SaveCapabilityModal
        repoRunId="rr_1"
        initialName="extract-pdf-tables"
        initialGoal="Extract tables from a PDF"
        subtitle="Why you'd save from here."
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("SaveCapabilityModal", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ skill: { id: "ls_1" } });
  });

  it("pre-fills both fields from the caller's derived values", () => {
    renderModal();
    expect(screen.getByDisplayValue("extract-pdf-tables")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Extract tables from a PDF")).toBeInTheDocument();
  });

  it("renders the caller's subtitle and submit label", () => {
    renderModal({ submitLabel: "Save to library" });
    expect(screen.getByText("Why you'd save from here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to library" })).toBeInTheDocument();
  });

  // Both call sites POST the same three fields; this is the contract that
  // used to be written out twice.
  it("posts name, goal_pattern and repo_run_id, then flips to the confirmation", async () => {
    renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "extract-pdf-tables",
        goal_pattern: "Extract tables from a PDF",
        repo_run_id: "rr_1",
      }),
    );
    expect(await screen.findByText(/Saved as/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View in Capabilities/ })).toHaveAttribute(
      "href",
      "/capabilities",
    );
  });

  it("surfaces a failed save without flipping to the confirmation", async () => {
    create.mockRejectedValue(new Error("name already taken"));
    renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("name already taken")).toBeInTheDocument();
    expect(screen.queryByText(/Saved as/)).toBeNull();
  });

  // The affordance is the run playground's only extra: the tasks page has no
  // transcript to derive a summary from, so it must not render a dead button.
  it("offers the agent's summary only when one is supplied and differs", async () => {
    renderModal({ summaryPattern: "Pull tables out of a scanned PDF" });
    const swap = screen.getByRole("button", { name: /Use agent's summary/ });
    await userEvent.click(swap);
    expect(
      screen.getByDisplayValue("Pull tables out of a scanned PDF"),
    ).toBeInTheDocument();
  });

  it("hides the summary affordance when there is no summary", () => {
    renderModal();
    expect(screen.queryByRole("button", { name: /Use agent's summary/ })).toBeNull();
  });

  it("hides the summary affordance when it already matches the goal", () => {
    renderModal({ summaryPattern: "Extract tables from a PDF" });
    expect(screen.queryByRole("button", { name: /Use agent's summary/ })).toBeNull();
  });

  // One `pattern` governs both surfaces now; the tasks page used to describe
  // it only as "a short slug".
  it("states the name constraint the input actually enforces", () => {
    renderModal();
    expect(screen.getByDisplayValue("extract-pdf-tables")).toHaveAttribute(
      "pattern",
      "[a-z0-9-]{2,64}",
    );
    expect(screen.getByText(/2–64 chars/)).toBeInTheDocument();
  });

  it("closes on Cancel", async () => {
    const { onClose } = renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
