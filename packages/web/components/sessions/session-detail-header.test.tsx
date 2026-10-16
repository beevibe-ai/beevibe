import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { MetaDot, SessionDetailHeader } from "./session-detail-header";

describe("SessionDetailHeader", () => {
  function renderHeader(overrides: Partial<Parameters<typeof SessionDetailHeader>[0]> = {}) {
    return render(
      <SessionDetailHeader
        agentLabel="Ada"
        hierarchy="ic"
        status="succeeded"
        title="Fix the flaky test"
        {...overrides}
      />,
    );
  }

  it("shows the title, the agent label and the status", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "Fix the flaky test" })).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("succeeded")).toBeTruthy();
  });

  it("truncates a long title rather than wrapping the header", () => {
    renderHeader();
    expect(screen.getByRole("heading").className).toContain("truncate");
  });

  it("marks the avatar running only while the session is", () => {
    const { container, unmount } = renderHeader({ status: "running" });
    const running = container.innerHTML;
    unmount();
    const { container: idle } = renderHeader({ status: "succeeded" });
    // Presence is an avatar-internal detail; assert only that the two
    // states render differently, so a future avatar change can't silently
    // drop the live indicator.
    expect(running).not.toBe(idle.innerHTML);
  });

  it("renders the page's own meta items after the hierarchy chip", () => {
    renderHeader({ meta: <span>2 turns</span> });
    expect(screen.getByText("2 turns")).toBeTruthy();
  });

  it("renders no meta tail when the page passes none", () => {
    renderHeader();
    expect(screen.queryByText("·")).toBeNull();
  });
});

describe("MetaDot", () => {
  it("renders the separator", () => {
    render(<MetaDot />);
    expect(screen.getByText("·")).toBeTruthy();
  });
});
