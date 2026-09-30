/**
 * The chip-button + popover primitive the Runtime, Model and
 * Review-policy pickers are all built from. Everything worth pinning
 * here is behaviour the three pickers inherit rather than re-implement:
 *
 *   - the ARIA contract (`aria-expanded`, and `aria-controls` pointing
 *     at the menu only while it exists) — a stale `aria-controls` on a
 *     closed popover points a screen reader at a removed node
 *   - Escape returning focus to the trigger, which is the one thing
 *     `ChipPopover` adds on top of `useDismissOnOutside`; without it a
 *     keyboard user is dropped at the top of the document
 *   - the `close` callback handed to the render prop, which is how every
 *     picker dismisses itself after a mutation fires
 *   - `disabled`, which is how the pickers lock the chip mid-mutation
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChipCaret, ChipMenuItem, ChipPopover, StatusDot } from "./chip-popover";

function renderPopover(
  props: Partial<React.ComponentProps<typeof ChipPopover>> = {},
) {
  return render(
    <ChipPopover ariaLabel="Open the thing" chip={<span>chip label</span>} {...props}>
      {(close) => (
        <button type="button" onClick={close}>
          dismiss me
        </button>
      )}
    </ChipPopover>,
  );
}

const trigger = () => screen.getByRole("button", { name: "Open the thing" });

describe("ChipPopover", () => {
  it("starts closed and renders the chip content in the trigger", () => {
    renderPopover();
    expect(trigger()).toHaveTextContent("chip label");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("toggles the menu open and shut on repeated trigger clicks", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    await user.click(trigger());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("points aria-controls at the live menu, and drops it when closed", async () => {
    const user = userEvent.setup();
    renderPopover();

    // Closed: nothing to point at.
    expect(trigger()).not.toHaveAttribute("aria-controls");

    await user.click(trigger());
    const controls = trigger().getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(screen.getByRole("menu")).toHaveAttribute("id", controls as string);

    await user.click(trigger());
    expect(trigger()).not.toHaveAttribute("aria-controls");
  });

  it("closes when the render prop's close callback fires", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(trigger());
    await user.click(screen.getByRole("button", { name: "dismiss me" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on a mousedown outside the popover", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <ChipPopover ariaLabel="Open the thing" chip={<span>chip</span>}>
          {() => <div>menu body</div>}
        </ChipPopover>
        <button type="button">somewhere else</button>
      </div>,
    );

    await user.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "somewhere else" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("leaves the menu open on a click inside it", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(trigger());
    // A mousedown inside must not dismiss — otherwise the menu would
    // vanish before the item's own onClick ever ran.
    await user.pointer({ target: screen.getByRole("menu"), keys: "[MouseLeft>]" });

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(trigger());
    const inner = screen.getByRole("button", { name: "dismiss me" });
    inner.focus();
    expect(inner).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("does not open while disabled", async () => {
    const user = userEvent.setup();
    renderPopover({ disabled: true });

    expect(trigger()).toBeDisabled();
    await user.click(trigger());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("aligns the menu to the requested edge", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPopover();
    await user.click(trigger());
    expect(screen.getByRole("menu").className).toContain("left-0");
    unmount();

    renderPopover({ align: "right" });
    await user.click(trigger());
    expect(screen.getByRole("menu").className).toContain("right-0");
  });

  it("applies the caller's chip classes to the trigger", () => {
    renderPopover({ chipClassName: "border-amber-500/45" });
    expect(trigger().className).toContain("border-amber-500/45");
  });
});

describe("ChipMenuItem", () => {
  it("renders as a menuitem and calls onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<ChipMenuItem label="Auto-done" onClick={onClick} />);

    const item = screen.getByRole("menuitem", { name: /Auto-done/ });
    await user.click(item);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("shows a checkmark only when selected", () => {
    const { unmount, container } = render(
      <ChipMenuItem label="Auto-done" selected onClick={() => {}} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
    unmount();

    const plain = render(<ChipMenuItem label="Auto-done" onClick={() => {}} />);
    expect(plain.container.querySelector("svg")).not.toBeInTheDocument();
  });

  it("lets an explicit trailing slot replace the selected checkmark", () => {
    render(
      <ChipMenuItem
        label="Auto-done"
        selected
        trailing={<span>trailing slot</span>}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText("trailing slot")).toBeInTheDocument();
    // The trailing override wins outright — no checkmark alongside it.
    expect(screen.getByRole("menuitem").querySelector("svg")).toBeNull();
  });

  it("renders the optional leading and sublabel slots", () => {
    render(
      <ChipMenuItem
        label="claude 2.0.1"
        leading={<span>lead</span>}
        sublabel="offline"
        onClick={() => {}}
      />,
    );
    expect(screen.getByText("lead")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("does not fire onClick while disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<ChipMenuItem label="Auto-done" disabled onClick={onClick} />);

    await user.click(screen.getByRole("menuitem"));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("StatusDot", () => {
  it.each([
    ["green", "bg-emerald-500"],
    ["amber", "bg-amber-500"],
    ["gray", "bg-muted-foreground/50"],
  ] as const)("paints the %s tone", (tone, expected) => {
    const { container } = render(<StatusDot tone={tone} />);
    expect(container.firstElementChild?.className).toContain(expected);
  });

  it("drops the glow ring when glow is off", () => {
    const glowing = render(<StatusDot tone="green" />);
    expect(glowing.container.firstElementChild?.className).toContain("shadow-");
    glowing.unmount();

    const flat = render(<StatusDot tone="green" glow={false} />);
    expect(flat.container.firstElementChild?.className).not.toContain("shadow-");
  });

  it("carries no glow ring on the gray tone even when glow is on", () => {
    const { container } = render(<StatusDot tone="gray" glow />);
    expect(container.firstElementChild?.className).not.toContain("shadow-");
  });
});

describe("ChipCaret", () => {
  it("renders a decorative caret that screen readers skip", () => {
    const { container } = render(<ChipCaret />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("aria-hidden");
  });
});
