import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useDismissOnOutside } from "./use-dismiss";

/**
 * Mount a real element, point a ref at it, and bind the hook to it —
 * the hook's whole job is the `contains` test against a live node.
 */
function setup(opts: { enabled?: boolean; onEscape?: () => void } = {}) {
  const el = document.createElement("div");
  const inside = document.createElement("button");
  el.appendChild(inside);
  document.body.appendChild(el);

  const onDismiss = vi.fn();
  const { unmount } = renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(el);
    useDismissOnOutside(ref, onDismiss, opts);
  });

  return {
    onDismiss,
    inside,
    unmount: () => {
      unmount();
      el.remove();
    },
  };
}

function mouseDownOn(target: EventTarget) {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

function pressKey(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("useDismissOnOutside", () => {
  it("dismisses on a mousedown outside the element", () => {
    const { onDismiss, unmount } = setup();
    mouseDownOn(document.body);
    expect(onDismiss).toHaveBeenCalledOnce();
    unmount();
  });

  it("ignores a mousedown on a descendant", () => {
    const { onDismiss, inside, unmount } = setup();
    mouseDownOn(inside);
    expect(onDismiss).not.toHaveBeenCalled();
    unmount();
  });

  it("dismisses on Escape and ignores other keys", () => {
    const { onDismiss, unmount } = setup();
    pressKey("Enter");
    expect(onDismiss).not.toHaveBeenCalled();
    pressKey("Escape");
    expect(onDismiss).toHaveBeenCalledOnce();
    unmount();
  });

  it("routes Escape to onEscape when one is supplied", () => {
    const onEscape = vi.fn();
    const { onDismiss, unmount } = setup({ onEscape });

    pressKey("Escape");
    expect(onEscape).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();

    // Click-outside still goes to onDismiss.
    mouseDownOn(document.body);
    expect(onDismiss).toHaveBeenCalledOnce();
    unmount();
  });

  it("binds nothing while disabled", () => {
    const { onDismiss, unmount } = setup({ enabled: false });
    mouseDownOn(document.body);
    pressKey("Escape");
    expect(onDismiss).not.toHaveBeenCalled();
    unmount();
  });

  it("unbinds on unmount", () => {
    const { onDismiss, unmount } = setup();
    unmount();
    mouseDownOn(document.body);
    pressKey("Escape");
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
