/**
 * Review policy decides whether an agent's "done" closes the task or
 * routes it through human sign-off, so the value the picker *sends* is
 * the load-bearing detail — a picker that renders "Auto-done" but posts
 * `require_human` silently changes how every task this agent finishes
 * behaves.
 *
 * The case worth pinning hardest is the legacy `review_policy`:
 * agents provisioned before the column had a default carry null/
 * undefined, which TaskService treats as `auto_done`. Both the chip and
 * the card have to render that the same way, or the UI reports a policy
 * the backend isn't running.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { AgentDisplay } from "@/lib/api/types";

vi.mock("@/lib/api/client", () => ({
  api: { agents: { setReviewPolicy: vi.fn() } },
}));

import { api } from "@/lib/api/client";
import { ReviewPolicyChip, ReviewPolicyPicker } from "./review-policy-picker";

const setPolicy = vi.mocked(api.agents.setReviewPolicy);

function agentWith(review_policy?: string): AgentDisplay {
  return {
    id: "agt_1",
    name: "backend",
    display_name: "Backend",
    hierarchy: "ic",
    hierarchy_level: "ic",
    owner_id: "u_1",
    created_at: new Date(),
    updated_at: new Date(),
    ...(review_policy === undefined ? {} : { review_policy }),
  };
}

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const result = render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
  return { ...result, invalidate };
}

beforeEach(() => {
  setPolicy.mockReset();
  setPolicy.mockResolvedValue({ ok: true } as never);
});

describe("ReviewPolicyChip", () => {
  it("renders a legacy null policy as Auto-done", () => {
    renderWithClient(<ReviewPolicyChip agent={agentWith(undefined)} />);
    expect(
      screen.getByRole("button", { name: /Review policy: Auto-done/ }),
    ).toHaveTextContent("Auto-done");
  });

  it("renders an unrecognized policy string as Auto-done too", () => {
    // Anything that isn't exactly `require_human` falls through to the
    // permissive default, matching TaskService.
    renderWithClient(<ReviewPolicyChip agent={agentWith("something_else")} />);
    expect(screen.getByRole("button", { name: /Auto-done/ })).toBeInTheDocument();
  });

  it("renders require_human with the eye icon and amber chip", () => {
    const { container } = renderWithClient(
      <ReviewPolicyChip agent={agentWith("require_human")} />,
    );
    const chip = screen.getByRole("button", { name: /Review policy: Require human/ });
    expect(chip).toHaveTextContent("Require human");
    expect(chip.className).toContain("amber");
    // The eye is the shape-encoded half of the signal.
    expect(container.querySelector("circle")).toBeInTheDocument();
  });

  it("posts require_human and closes the popover on select", async () => {
    const user = userEvent.setup();
    const { invalidate } = renderWithClient(
      <ReviewPolicyChip agent={agentWith("auto_done")} />,
    );

    await user.click(screen.getByRole("button", { name: /Review policy/ }));
    await user.click(screen.getByRole("menuitem", { name: /Require human/ }));

    expect(setPolicy).toHaveBeenCalledWith("agt_1", "require_human");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // Both agent caches get bumped — the list view and the detail read
    // from separate slots, and missing one makes the change look lost.
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agent-network"] });
    });
  });

  it("posts auto_done when switching back", async () => {
    const user = userEvent.setup();
    renderWithClient(<ReviewPolicyChip agent={agentWith("require_human")} />);

    await user.click(screen.getByRole("button", { name: /Review policy/ }));
    await user.click(screen.getByRole("menuitem", { name: /Auto-done/ }));

    expect(setPolicy).toHaveBeenCalledWith("agt_1", "auto_done");
  });

  it("marks the current policy as the selected menu item", async () => {
    const user = userEvent.setup();
    renderWithClient(<ReviewPolicyChip agent={agentWith("require_human")} />);

    await user.click(screen.getByRole("button", { name: /Review policy/ }));
    const [autoDone, requireHuman] = screen.getAllByRole("menuitem");

    // Selected rows carry the checkmark; unselected ones don't.
    expect(requireHuman.querySelectorAll("polyline")).toHaveLength(1);
    expect(autoDone.querySelector("polyline")).toBeNull();
  });
});

describe("ReviewPolicyPicker", () => {
  it("selects the current policy, defaulting a legacy null to auto_done", () => {
    renderWithClient(<ReviewPolicyPicker agent={agentWith(undefined)} />);
    expect(screen.getByRole("combobox")).toHaveValue("auto_done");
  });

  it("posts the newly chosen policy", async () => {
    const user = userEvent.setup();
    renderWithClient(<ReviewPolicyPicker agent={agentWith("auto_done")} />);

    await user.selectOptions(screen.getByRole("combobox"), "require_human");

    expect(setPolicy).toHaveBeenCalledWith("agt_1", "require_human");
  });

  it("surfaces a failed update instead of silently keeping the old value", async () => {
    const user = userEvent.setup();
    setPolicy.mockRejectedValue(new Error("boom"));
    renderWithClient(<ReviewPolicyPicker agent={agentWith("auto_done")} />);

    await user.selectOptions(screen.getByRole("combobox"), "require_human");

    expect(await screen.findByText(/Couldn't update review policy/)).toBeInTheDocument();
  });

  it("shows no error line on a clean render", () => {
    renderWithClient(<ReviewPolicyPicker agent={agentWith("auto_done")} />);
    expect(screen.queryByText(/Couldn't update review policy/)).not.toBeInTheDocument();
  });
});
