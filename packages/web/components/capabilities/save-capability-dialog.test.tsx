import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createSkill = vi.fn();

vi.mock("@/lib/api/client", () => ({
  api: { learnedSkills: { create: (...args: unknown[]) => createSkill(...args) } },
}));

import { SaveCapabilityDialog } from "./save-capability-dialog";

function renderDialog(props: Partial<Parameters<typeof SaveCapabilityDialog>[0]> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(
    <SaveCapabilityDialog
      repoRunId="rr_1"
      initialName="extract-pdf-tables"
      initialGoal="extract tables from a PDF"
      onClose={onClose}
      {...props}
    />,
    { wrapper: Wrapper },
  );
  return { onClose };
}

beforeEach(() => {
  createSkill.mockReset();
  createSkill.mockResolvedValue({ ok: true });
});

describe("SaveCapabilityDialog", () => {
  it("posts the two fields against the run it was opened for", async () => {
    renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() =>
      expect(createSkill).toHaveBeenCalledWith({
        name: "extract-pdf-tables",
        goal_pattern: "extract tables from a PDF",
        repo_run_id: "rr_1",
      }),
    );
  });

  it("sends what the user edited, not the defaults", async () => {
    renderDialog();

    const goal = screen.getByLabelText("Goal pattern");
    await userEvent.clear(goal);
    await userEvent.type(goal, "pull tables out of a report");
    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() =>
      expect(createSkill.mock.calls[0]?.[0]).toMatchObject({
        goal_pattern: "pull tables out of a report",
      }),
    );
  });

  // The done state is the only confirmation the user gets — the dialog does
  // not close itself, because the link to /capabilities is the point.
  it("swaps the form for a confirmation once the save lands", async () => {
    const { onClose } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /View in Capabilities/ })).toHaveAttribute(
        "href",
        "/capabilities",
      ),
    );
    expect(screen.queryByLabelText("Goal pattern")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the form up and shows why when the save fails", async () => {
    createSkill.mockRejectedValueOnce(new Error("name already taken"));
    renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Save to library" }));

    await waitFor(() => expect(screen.getByText("name already taken")).toBeInTheDocument());
    expect(screen.getByLabelText("Goal pattern")).toBeInTheDocument();
  });

  describe("the agent's suggested goal", () => {
    // Only the run detail page has one of these; the task page opens the
    // same dialog without it, and must not grow a dead button.
    it("is not offered when the caller has no suggestion", () => {
      renderDialog();
      expect(screen.queryByRole("button", { name: /Use agent/ })).toBeNull();
    });

    it("is not offered when it is already what's in the box", () => {
      renderDialog({ initialGoal: "same text", suggestedGoal: "same text" });
      expect(screen.queryByRole("button", { name: /Use agent/ })).toBeNull();
    });

    it("replaces the goal when taken, and stops offering itself", async () => {
      renderDialog({ suggestedGoal: "extract tabular data from documents" });

      await userEvent.click(screen.getByRole("button", { name: /Use agent/ }));

      expect(screen.getByLabelText("Goal pattern")).toHaveValue(
        "extract tabular data from documents",
      );
      expect(screen.queryByRole("button", { name: /Use agent/ })).toBeNull();
    });
  });

  it("shows the caller's note about where the default goal came from", () => {
    renderDialog({ goalHint: "Default comes from this work product's summary." });
    expect(
      screen.getByText(/Default comes from this work product's summary\./),
    ).toBeInTheDocument();
  });

  it("dismisses on Cancel without saving", async () => {
    const { onClose } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(createSkill).not.toHaveBeenCalled();
  });
});
