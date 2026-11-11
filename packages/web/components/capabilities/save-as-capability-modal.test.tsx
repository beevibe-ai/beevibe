import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const create = vi.fn();

vi.mock("@/lib/api/client", () => ({
  api: {
    learnedSkills: {
      create: (input: unknown) => create(input),
    },
  },
}));

import { SaveAsCapabilityModal } from "./save-as-capability-modal";

function renderModal(props: Partial<React.ComponentProps<typeof SaveAsCapabilityModal>> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SaveAsCapabilityModal
        repoRunId="rr_1"
        initialName="extract-pdf-tables"
        initialGoal="extract tables from a PDF"
        blurb="Remember this recipe."
        nameHint="A short slug."
        goalLabel="When should this trigger?"
        goalHint="Describe the situation."
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("SaveAsCapabilityModal", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ skill: { id: "ls_1" } });
  });

  it("prefills both fields from the caller's defaults", () => {
    renderModal();
    expect(screen.getByLabelText("Capability name")).toHaveValue("extract-pdf-tables");
    expect(screen.getByLabelText("When should this trigger?")).toHaveValue(
      "extract tables from a PDF",
    );
  });

  it("posts the edited name and goal against the run id", async () => {
    renderModal();
    const name = screen.getByLabelText("Capability name");
    await userEvent.clear(name);
    await userEvent.type(name, "pdf-tables");
    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "pdf-tables",
        goal_pattern: "extract tables from a PDF",
        repo_run_id: "rr_1",
      }),
    );
  });

  // The whole point of the dialog is the confirmation — a user who saved
  // needs the link to where the capability landed.
  it("flips to the confirmation with a link to /capabilities on success", async () => {
    renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() =>
      expect(screen.getByText(/Saved as/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /View in Capabilities/ })).toHaveAttribute(
      "href",
      "/capabilities",
    );
    expect(screen.queryByLabelText("Capability name")).toBeNull();
  });

  it("surfaces the failure message and stays on the form", async () => {
    create.mockRejectedValue(new Error("name already taken"));
    renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() => expect(screen.getByText("name already taken")).toBeInTheDocument());
    expect(screen.getByLabelText("Capability name")).toBeInTheDocument();
  });

  // The run outro offers the agent's wrap-up summary as a second
  // candidate; the task card passes none and must not render a button.
  it("offers the goal suggestion only when one is passed and differs", async () => {
    renderModal({
      goalSuggestion: { label: "Use agent's summary →", value: "summarize a repo's skills" },
    });
    await userEvent.click(screen.getByRole("button", { name: /Use agent's summary/ }));
    expect(screen.getByLabelText("When should this trigger?")).toHaveValue(
      "summarize a repo's skills",
    );
    // Once taken, the suggestion matches the field and stops being offered.
    expect(screen.queryByRole("button", { name: /Use agent's summary/ })).toBeNull();
  });

  it("renders no suggestion button without a suggestion", () => {
    renderModal();
    expect(screen.queryByRole("button", { name: /summary/ })).toBeNull();
  });

  it("closes without saving on Cancel", async () => {
    const { onClose } = renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
