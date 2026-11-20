import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

const create = vi.fn();

vi.mock("@/lib/api/client", () => ({
  api: {
    learnedSkills: {
      create: (...args: unknown[]) => create(...args),
    },
  },
}));

import { SaveCapabilityModal } from "./save-capability-modal";

function renderModal(props: Partial<Parameters<typeof SaveCapabilityModal>[0]> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
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
  it("posts the edited name and goal with the run id", async () => {
    create.mockResolvedValue({ ok: true });
    renderModal();

    await userEvent.clear(screen.getByLabelText("Capability name"));
    await userEvent.type(screen.getByLabelText("Capability name"), "parse-csv");
    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "parse-csv",
        goal_pattern: "extract tables from a PDF",
        repo_run_id: "rr_1",
      }),
    );
  });

  it("flips to the confirmation on success instead of closing itself", async () => {
    // The run page and the task page both relied on this: the dialog stays
    // open showing the "View in Capabilities" link, and onClose only fires
    // when the user dismisses it.
    create.mockResolvedValue({ ok: true });
    const { onClose } = renderModal();

    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() => expect(screen.getByText(/Saved as/)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /View in Capabilities/ })).toHaveAttribute(
      "href",
      "/capabilities",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces a failed save and keeps the form up", async () => {
    create.mockRejectedValue(new Error("name already taken"));
    renderModal();

    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() =>
      expect(screen.getByText("name already taken")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Capability name")).toBeInTheDocument();
  });

  it("offers altGoal as a one-click replacement, then hides the button", async () => {
    renderModal({ altGoal: { label: "Use agent's summary →", value: "parse a CSV export" } });

    const useSummary = screen.getByRole("button", { name: /Use agent's summary/ });
    await userEvent.click(useSummary);

    expect(screen.getByLabelText("When should this trigger?")).toHaveValue(
      "parse a CSV export",
    );
    // Now that the box matches the suggestion there is nothing to adopt.
    expect(screen.queryByRole("button", { name: /Use agent's summary/ })).toBeNull();
  });

  it("hides the altGoal button when no alternative was derived", () => {
    // deriveSummaryGoalPattern returns undefined for a transcript with
    // nothing usable in it; the shortcut must not render an empty button.
    renderModal();
    expect(screen.queryByRole("button", { name: /Use agent's summary/ })).toBeNull();
  });
});
