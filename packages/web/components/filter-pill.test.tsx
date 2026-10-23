import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FilterPill } from "./filter-pill";

describe("FilterPill", () => {
  it("marks the active pill as pressed for assistive tech", () => {
    // The five pill rows all signalled selection with color alone before
    // this component existed.
    render(
      <>
        <FilterPill active onClick={() => {}}>
          Daily
        </FilterPill>
        <FilterPill active={false} onClick={() => {}}>
          Weekly
        </FilterPill>
      </>,
    );
    expect(screen.getByRole("button", { name: "Daily" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Weekly" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("gives the active pill the filled treatment and the inactive one the hover treatment", () => {
    const { rerender } = render(
      <FilterPill active onClick={() => {}}>
        Mine
      </FilterPill>,
    );
    const pill = () => screen.getByRole("button", { name: "Mine" });
    expect(pill().className).toContain("bg-secondary");
    expect(pill().className).not.toContain("hover:bg-secondary");

    rerender(
      <FilterPill active={false} onClick={() => {}}>
        Mine
      </FilterPill>,
    );
    expect(pill().className).toContain("hover:bg-secondary");
  });

  it("keeps per-row geometry passed through className", () => {
    // The rows legitimately differ in height/padding; only the
    // active/inactive formula is shared.
    render(
      <FilterPill active={false} onClick={() => {}} className="h-6 px-2">
        All time
      </FilterPill>,
    );
    expect(screen.getByRole("button", { name: "All time" }).className).toContain(
      "h-6 px-2",
    );
  });

  it("does not fire onClick while disabled", async () => {
    // The mesh activity feed disables a type filter with no matches; the
    // capabilities tabs disable every tab mid-search.
    const onClick = vi.fn();
    render(
      <FilterPill active={false} disabled onClick={onClick}>
        ask
      </FilterPill>,
    );
    const pill = screen.getByRole("button", { name: "ask" });
    expect(pill).toBeDisabled();
    expect(pill.className).toContain("cursor-not-allowed");
    await userEvent.click(pill);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fires onClick when enabled", async () => {
    const onClick = vi.fn();
    render(
      <FilterPill active={false} onClick={onClick}>
        org
      </FilterPill>,
    );
    await userEvent.click(screen.getByRole("button", { name: "org" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
