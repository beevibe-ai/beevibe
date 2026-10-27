import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      initialGoal="extract tables from a pdf"
      description="Save the recipe."
      goalLabel="Goal pattern"
      onClose={onClose}
      {...props}
    />,
    { wrapper: Wrapper },
  );
  return { onClose };
}

const nameField = () => screen.getByPlaceholderText("extract-pdf-tables");

describe("SaveCapabilityModal", () => {
  it("seeds both fields from the initial values", () => {
    renderModal();
    expect(nameField()).toHaveValue("extract-tables");
    expect(screen.getByText("Goal pattern")).toBeTruthy();
  });

  it("posts the edited name and goal with the run id", async () => {
    createMock.mockResolvedValue({ skill: {} } as never);
    renderModal();
    fireEvent.change(nameField(), { target: { value: "pdf-tables" } });
    fireEvent.submit(nameField().closest("form")!);
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: "pdf-tables",
        goal_pattern: "extract tables from a pdf",
        repo_run_id: "rr_1",
      }),
    );
  });

  it("flips to the confirmation once the save lands", async () => {
    createMock.mockResolvedValue({ skill: {} } as never);
    renderModal();
    fireEvent.submit(nameField().closest("form")!);
    await waitFor(() => expect(screen.getByText("View in Capabilities →")).toBeTruthy());
    // The form is gone, so a second submit can't double-post.
    expect(screen.queryByPlaceholderText("extract-pdf-tables")).toBeNull();
  });

  it("surfaces a failed save and keeps the form open for a retry", async () => {
    createMock.mockRejectedValue(new Error("name already taken"));
    renderModal();
    fireEvent.submit(nameField().closest("form")!);
    await waitFor(() => expect(screen.getByText("name already taken")).toBeTruthy());
    expect(nameField()).toBeTruthy();
  });

  it("offers the suggestion only while it differs from the field", () => {
    renderModal({ goalSuggestion: "a better pattern" });
    const button = screen.getByText("Use agent's summary →");
    fireEvent.click(button);
    expect(screen.queryByText("Use agent's summary →")).toBeNull();
  });

  it("omits the suggestion button when no suggestion is supplied", () => {
    renderModal();
    expect(screen.queryByText("Use agent's summary →")).toBeNull();
  });

  it("passes the live name to nameHelp so a caller can preview the slug", () => {
    renderModal({ nameHelp: (name) => <span data-testid="help">/skill/{name}</span> });
    expect(screen.getByTestId("help")).toHaveTextContent("/skill/extract-tables");
    fireEvent.change(nameField(), { target: { value: "renamed" } });
    expect(screen.getByTestId("help")).toHaveTextContent("/skill/renamed");
  });

  it("closes on Cancel without posting", () => {
    const { onClose } = renderModal();
    createMock.mockClear();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});
