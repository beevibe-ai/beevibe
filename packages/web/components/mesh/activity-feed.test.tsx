import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeshActivityFeed } from "./activity-feed";
import type { MeshAsk } from "@/lib/types/mesh";

function makeAsk(overrides: Partial<MeshAsk> = {}): MeshAsk {
  return {
    id: "ask_1",
    caller: "alice",
    target: "bob",
    type: "ask",
    status: "succeeded",
    duration_label: "1.2s",
    intent: "Can you review the auth diff?",
    chain_depth: "1",
    ...overrides,
  };
}

/** The header count lives in the <h2>, next to the "Recent asks" label. */
function headerCount(): string {
  return screen.getByRole("heading", { level: 2 }).textContent!.replace(/\D/g, "");
}

function filterButton(label: string) {
  return screen
    .getAllByRole("button")
    .find((b) => b.textContent!.startsWith(label))!;
}

describe("MeshActivityFeed", () => {
  it("renders one row per ask and counts them in the header", () => {
    render(
      <MeshActivityFeed
        asks={[
          makeAsk({ id: "a1", caller: "alice", target: "bob" }),
          makeAsk({ id: "a2", caller: "carol", target: "dave" }),
        ]}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(headerCount()).toBe("2");
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("dave")).toBeInTheDocument();
  });

  it("shows a per-type count on each filter and filters rows when clicked", async () => {
    const user = userEvent.setup();
    render(
      <MeshActivityFeed
        asks={[
          makeAsk({ id: "a1", type: "ask", caller: "alice" }),
          makeAsk({ id: "a2", type: "blocker", caller: "carol" }),
          makeAsk({ id: "a3", type: "blocker", caller: "erin" }),
        ]}
      />,
    );

    // counts come from countByType, not from the visible list
    expect(filterButton("blocker").textContent).toContain("2");
    expect(filterButton("ask").textContent).toContain("1");

    await user.click(filterButton("blocker"));

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("carol")).toBeInTheDocument();
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    expect(headerCount()).toBe("2");
  });

  it("disables a type filter with no asks and omits its count badge", () => {
    render(<MeshActivityFeed asks={[makeAsk({ type: "ask" })]} />);

    expect(filterButton("negotiate")).toBeDisabled();
    // count badge is only rendered when count > 0
    expect(filterButton("negotiate").textContent).toBe("negotiate");
    // "All" is never disabled, even though it carries no badge
    expect(filterButton("All")).toBeEnabled();
  });

  it("narrows to the selected agent on either side of the arrow", () => {
    render(
      <MeshActivityFeed
        selectedAgent="bob"
        asks={[
          makeAsk({ id: "a1", caller: "alice", target: "bob" }),
          makeAsk({ id: "a2", caller: "bob", target: "carol" }),
          makeAsk({ id: "a3", caller: "dave", target: "erin" }),
        ]}
      />,
    );

    // a1 (target) and a2 (caller) survive; a3 touches bob on neither side
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("dave")).not.toBeInTheDocument();
    expect(screen.getByText("Filtered to")).toBeInTheDocument();
  });

  it("fires onClearSelection from the filter chip's X", async () => {
    const user = userEvent.setup();
    const onClearSelection = vi.fn();
    render(
      <MeshActivityFeed
        selectedAgent="bob"
        onClearSelection={onClearSelection}
        asks={[makeAsk({ caller: "bob" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it("offers the onboarding CTA only when there are no asks at all", () => {
    render(<MeshActivityFeed asks={[]} />);

    expect(screen.getByText("No mesh asks yet")).toBeInTheDocument();
    expect(screen.getByText(/When agents ask each other for help/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open chat/ })).toHaveAttribute("href", "/");
  });

  it("treats a missing asks prop as an empty feed", () => {
    render(<MeshActivityFeed />);

    expect(screen.getByText("No mesh asks yet")).toBeInTheDocument();
    expect(headerCount()).toBe("0");
  });

  it("names the agent, and drops the CTA, when the selection filters everything out", () => {
    render(<MeshActivityFeed selectedAgent="zoe" asks={[makeAsk({ caller: "alice" })]} />);

    expect(screen.getByText("No asks for zoe")).toBeInTheDocument();
    // the CTA + description are reserved for the genuinely-empty feed
    expect(screen.queryByRole("link", { name: /Open chat/ })).not.toBeInTheDocument();
  });

  it("names the active type when live data drops the last ask of that type", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MeshActivityFeed
        asks={[makeAsk({ id: "a1", type: "ask" }), makeAsk({ id: "a2", type: "blocker" })]}
      />,
    );

    await user.click(filterButton("blocker"));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    // the blocker ages out of the window while its filter is still active
    rerender(<MeshActivityFeed asks={[makeAsk({ id: "a1", type: "ask" })]} />);

    expect(screen.getByText("No blocker asks in this window")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open chat/ })).not.toBeInTheDocument();
  });

  it("routes a negotiate row to its transcript page", () => {
    render(<MeshActivityFeed asks={[makeAsk({ id: "neg_7", type: "negotiate" })]} />);

    expect(screen.getByRole("link")).toHaveAttribute("href", "/negotiations/neg_7");
  });

  it("routes an ask row to its source task when one is known", () => {
    render(
      <MeshActivityFeed
        asks={[makeAsk({ id: "a1", type: "ask", source_task_short_id: "T-42" })]}
      />,
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/tasks/T-42");
  });

  it("renders an unlinked row when an ask has no source task", () => {
    render(<MeshActivityFeed asks={[makeAsk({ type: "blocker" })]} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // the row still renders, carrying its type badge
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("blocker")).toBeInTheDocument();
  });

  it("reports the hovered row, and clears it on leave", async () => {
    const user = userEvent.setup();
    const onHoverRow = vi.fn();
    render(
      <MeshActivityFeed
        onHoverRow={onHoverRow}
        asks={[makeAsk({ id: "a1", caller: "alice", target: "bob" })]}
      />,
    );

    const row = screen.getByRole("listitem");
    await user.hover(within(row).getByText("alice"));
    expect(onHoverRow).toHaveBeenCalledWith({ askId: "a1", caller: "alice", target: "bob" });

    await user.unhover(row);
    expect(onHoverRow).toHaveBeenLastCalledWith(null);
  });
});
