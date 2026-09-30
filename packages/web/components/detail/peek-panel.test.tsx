/**
 * The peek-panel shell behind both the agent peek (over the network
 * canvas) and the task peek (over the kanban). It owns three things the
 * callers rely on and don't re-implement: the dialog role + label, the
 * two dismiss routes (Escape and click-outside), and the `data-pan`
 * opt-out that stops a drag inside the panel from panning the canvas
 * underneath it.
 *
 * That last one is easy to regress into a boolean attribute — rendering
 * `data-pan="false"` instead of omitting it would make `closest(
 * '[data-pan="ignore"]')` miss, and the canvas would pan under the
 * panel; but a hardcoded "ignore" would freeze panning for the task
 * peek, which has no canvas to protect.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PanelFooterField, PeekPanel } from "./peek-panel";

function renderPanel(props: Partial<React.ComponentProps<typeof PeekPanel>> = {}) {
  const onClose = vi.fn();
  const result = render(
    <div>
      <PeekPanel
        ariaLabel="Task details"
        fullPageHref="/tasks/tsk_1"
        onClose={onClose}
        {...props}
      >
        <p>body content</p>
      </PeekPanel>
      <button type="button">outside</button>
    </div>,
  );
  return { ...result, onClose };
}

describe("PeekPanel", () => {
  it("renders as a labelled dialog around the caller's body", () => {
    renderPanel();
    const panel = screen.getByRole("dialog", { name: "Task details" });
    expect(panel).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("links out to the full page route", () => {
    renderPanel();
    expect(screen.getByRole("link", { name: /Open full page/ })).toHaveAttribute(
      "href",
      "/tasks/tsk_1",
    );
  });

  it("closes from the close button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a click outside", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open on a click inside the panel body", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    await user.click(screen.getByText("body content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("omits data-pan by default so the underlying canvas still pans", () => {
    renderPanel();
    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-pan");
  });

  it('marks itself data-pan="ignore" when asked', () => {
    renderPanel({ ignorePan: true });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-pan", "ignore");
  });

  it("merges the caller's className onto the aside", () => {
    renderPanel({ className: "z-40" });
    expect(screen.getByRole("dialog").className).toContain("z-40");
  });
});

describe("PanelFooterField", () => {
  it("renders its label above the value", () => {
    render(<PanelFooterField label="Owner">alice</PanelFooterField>);
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("truncates long values rather than widening the footer grid", () => {
    render(<PanelFooterField label="Id">tsk_0123456789abcdef</PanelFooterField>);
    expect(screen.getByText("tsk_0123456789abcdef").className).toContain("truncate");
  });
});
