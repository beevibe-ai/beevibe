import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const create = vi.fn();

vi.mock("@/lib/api/client", () => ({
  api: {
    learnedSkills: {
      create: (body: unknown) => create(body),
    },
  },
}));

import { SaveCapabilityModal } from "./save-capability-modal";

function renderModal(props: Partial<Parameters<typeof SaveCapabilityModal>[0]> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(
    <Wrapper>
      <SaveCapabilityModal
        repoRunId="rr_1"
        initialName="extract-pdf-tables"
        initialGoal="pull tables out of a pdf"
        onClose={onClose}
        {...props}
      />
    </Wrapper>,
  );
  return { onClose };
}

describe("SaveCapabilityModal", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("pre-fills both fields from the initial values", () => {
    renderModal();
    expect(screen.getByDisplayValue("extract-pdf-tables")).toBeInTheDocument();
    expect(screen.getByDisplayValue("pull tables out of a pdf")).toBeInTheDocument();
  });

  it("POSTs name + goal_pattern + repo_run_id, the body both surfaces send", async () => {
    create.mockResolvedValueOnce({ id: "ls_1" });
    renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "extract-pdf-tables",
        goal_pattern: "pull tables out of a pdf",
        repo_run_id: "rr_1",
      }),
    );
  });

  it("flips to the confirmation with a link to /capabilities on success", async () => {
    create.mockResolvedValueOnce({ id: "ls_1" });
    renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const link = await screen.findByRole("link", { name: /View in Capabilities/ });
    expect(link).toHaveAttribute("href", "/capabilities");
    // The form is gone — no second submit from the confirmation state.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("surfaces the server's message when the save fails", async () => {
    create.mockRejectedValueOnce(new Error("name already taken"));
    renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("name already taken")).toBeInTheDocument();
  });

  it("offers the agent's summary only when one is passed and it differs", async () => {
    renderModal({ summaryPattern: "extract tabular data from reports" });
    const useSummary = screen.getByRole("button", { name: /Use agent's summary/ });
    await userEvent.click(useSummary);
    expect(
      screen.getByDisplayValue("extract tabular data from reports"),
    ).toBeInTheDocument();
    // Once applied it matches the field, so the affordance retires itself.
    expect(
      screen.queryByRole("button", { name: /Use agent's summary/ }),
    ).not.toBeInTheDocument();
  });

  it("hides the summary affordance on surfaces that pass none", () => {
    // The task work-product surface has no agent wrap-up to derive one from.
    renderModal();
    expect(
      screen.queryByRole("button", { name: /Use agent's summary/ }),
    ).not.toBeInTheDocument();
  });

  it("closes on Cancel without saving", async () => {
    const { onClose } = renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});
