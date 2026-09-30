/**
 * The mesh canvas's pan/zoom. Everything here is arithmetic that is
 * invisible until it's wrong, so the cases pin the numbers rather than
 * "something moved":
 *
 *   - cursor-anchored zoom: the world point under the cursor has to stay
 *     under the cursor across a scale change. Off-by-one in the anchor
 *     maths reads as the canvas lurching away from where you pointed.
 *   - clamping, and the early return once clamped — without the early
 *     return, a wheel at max scale still rewrites x/y and drifts the
 *     canvas while appearing not to zoom.
 *   - `data-pan="ignore"`, which is the only thing stopping a click on
 *     an agent card from dragging the canvas under it.
 *   - `will-change`, pinned on during a gesture and cleared ~200ms after
 *     it, because leaving it on bitmap-scales text into a blur at rest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { usePanZoom, type PanZoomController } from "./use-pan-zoom";

const RECT = { left: 100, top: 50, width: 800, height: 600 };

/**
 * Mount a real container, hand it to the hook's ref, and stub the
 * geometry the hook reads. happy-dom lays nothing out, so
 * `getBoundingClientRect` would otherwise be all zeros and every anchor
 * assertion would collapse to the same point.
 */
function setup(opts: Parameters<typeof usePanZoom>[0] = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    ...RECT,
    right: RECT.left + RECT.width,
    bottom: RECT.top + RECT.height,
    x: RECT.left,
    y: RECT.top,
    toJSON: () => ({}),
  } as DOMRect);
  // happy-dom doesn't implement pointer capture.
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();

  let controller!: PanZoomController;
  const { unmount, rerender } = renderHook(() => {
    const c = usePanZoom(opts);
    // The hook owns its own ref; point it at our mounted node.
    (c.containerRef as { current: HTMLDivElement | null }).current = el;
    controller = c;
    return c;
  });

  // Effects bound their listeners against `containerRef.current`, which
  // was null on the first pass — re-render now that it's set.
  rerender();

  return {
    el,
    get ctl() {
      return controller;
    },
    unmount: () => {
      unmount();
      el.remove();
    },
  };
}

/**
 * happy-dom's WheelEvent constructor honours `deltaY` but drops
 * `clientX`/`clientY`, so the cursor coordinates have to be assigned
 * onto the instance — otherwise the anchor maths silently runs on
 * `undefined` and every transform comes back NaN.
 */
function wheel(el: HTMLElement, deltaY: number, clientX: number, clientY: number) {
  act(() => {
    const e = new WheelEvent("wheel", { deltaY, cancelable: true, bubbles: true });
    Object.assign(e, { clientX, clientY });
    el.dispatchEvent(e);
  });
}

function pointer(
  el: HTMLElement,
  type: string,
  init: { clientX?: number; clientY?: number; button?: number; target?: HTMLElement } = {},
) {
  act(() => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, {
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      button: init.button ?? 0,
      pointerId: 1,
    });
    if (init.target) {
      Object.defineProperty(e, "target", { value: init.target, configurable: true });
    }
    el.dispatchEvent(e);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePanZoom", () => {
  it("starts at identity and exposes a matching transform string", () => {
    const h = setup();
    expect(h.ctl.transform).toEqual({ x: 0, y: 0, scale: 1 });
    expect(h.ctl.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(h.ctl.style.transformOrigin).toBe("0 0");
    h.unmount();
  });

  it("honours an initial transform, including a partial one", () => {
    const h = setup({ initial: { x: 10, scale: 1.5 } });
    expect(h.ctl.transform).toEqual({ x: 10, y: 0, scale: 1.5 });
    h.unmount();
  });

  it("zooms in on a negative wheel delta and out on a positive one", () => {
    const h = setup();

    wheel(h.el, -100, RECT.left, RECT.top);
    expect(h.ctl.transform.scale).toBeGreaterThan(1);

    const zoomedIn = h.ctl.transform.scale;
    wheel(h.el, 200, RECT.left, RECT.top);
    expect(h.ctl.transform.scale).toBeLessThan(zoomedIn);

    h.unmount();
  });

  it("keeps the world point under the cursor fixed across a zoom", () => {
    const h = setup();

    // Cursor at container-local (300, 200).
    const cx = 300;
    const cy = 200;
    const before = h.ctl.transform;
    const worldX = (cx - before.x) / before.scale;
    const worldY = (cy - before.y) / before.scale;

    wheel(h.el, -120, RECT.left + cx, RECT.top + cy);

    const after = h.ctl.transform;
    expect(after.scale).not.toBe(before.scale);
    // Same world point must still project to the same screen point.
    expect(after.x + worldX * after.scale).toBeCloseTo(cx, 6);
    expect(after.y + worldY * after.scale).toBeCloseTo(cy, 6);

    h.unmount();
  });

  it("clamps zoom to the configured bounds", () => {
    const h = setup({ minScale: 0.5, maxScale: 2 });

    for (let i = 0; i < 40; i++) wheel(h.el, -200, RECT.left, RECT.top);
    expect(h.ctl.transform.scale).toBe(2);

    for (let i = 0; i < 80; i++) wheel(h.el, 200, RECT.left, RECT.top);
    expect(h.ctl.transform.scale).toBe(0.5);

    h.unmount();
  });

  it("does not drift the canvas once the scale is pinned at a bound", () => {
    const h = setup({ maxScale: 1 });

    wheel(h.el, -200, RECT.left + 400, RECT.top + 300);

    // Already at maxScale, so the handler must bail before touching x/y.
    expect(h.ctl.transform).toEqual({ x: 0, y: 0, scale: 1 });
    h.unmount();
  });

  it("prevents the wheel default so the page never scrolls under the canvas", () => {
    const h = setup();
    const e = new WheelEvent("wheel", {
      deltaY: -100,
      clientX: RECT.left,
      clientY: RECT.top,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      h.el.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    h.unmount();
  });

  it("pans by the pointer delta while dragging", () => {
    const h = setup();

    pointer(h.el, "pointerdown", { clientX: 200, clientY: 200 });
    pointer(h.el, "pointermove", { clientX: 230, clientY: 180 });

    expect(h.ctl.transform).toEqual({ x: 30, y: -20, scale: 1 });

    // Deltas accumulate across moves.
    pointer(h.el, "pointermove", { clientX: 250, clientY: 180 });
    expect(h.ctl.transform.x).toBe(50);

    h.unmount();
  });

  it("captures the pointer and shows a grabbing cursor for the drag", () => {
    const h = setup();

    pointer(h.el, "pointerdown", { clientX: 200, clientY: 200 });
    expect(h.el.setPointerCapture).toHaveBeenCalledWith(1);
    expect(h.el.style.cursor).toBe("grabbing");

    pointer(h.el, "pointerup", { clientX: 200, clientY: 200 });
    expect(h.el.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(h.el.style.cursor).toBe("");

    h.unmount();
  });

  it("ignores a pointermove that arrives without a drag in progress", () => {
    const h = setup();
    pointer(h.el, "pointermove", { clientX: 400, clientY: 400 });
    expect(h.ctl.transform).toEqual({ x: 0, y: 0, scale: 1 });
    h.unmount();
  });

  it("stops panning after the drag ends", () => {
    const h = setup();

    pointer(h.el, "pointerdown", { clientX: 200, clientY: 200 });
    pointer(h.el, "pointermove", { clientX: 210, clientY: 200 });
    pointer(h.el, "pointerup", { clientX: 210, clientY: 200 });
    pointer(h.el, "pointermove", { clientX: 900, clientY: 900 });

    expect(h.ctl.transform.x).toBe(10);
    h.unmount();
  });

  it.each(["pointercancel", "pointerleave"])("stops panning on %s too", (type) => {
    const h = setup();

    pointer(h.el, "pointerdown", { clientX: 200, clientY: 200 });
    pointer(h.el, "pointermove", { clientX: 210, clientY: 200 });
    pointer(h.el, type, { clientX: 210, clientY: 200 });
    pointer(h.el, "pointermove", { clientX: 900, clientY: 900 });

    expect(h.ctl.transform.x).toBe(10);
    h.unmount();
  });

  it("survives a release the browser already took back", () => {
    const h = setup();
    h.el.releasePointerCapture = vi.fn(() => {
      throw new Error("InvalidPointerId");
    });

    pointer(h.el, "pointerdown", { clientX: 200, clientY: 200 });
    expect(() => pointer(h.el, "pointerup", { clientX: 200, clientY: 200 })).not.toThrow();
    expect(h.el.style.cursor).toBe("");

    h.unmount();
  });

  it("does not start a pan from a middle or right click", () => {
    const h = setup();

    pointer(h.el, "pointerdown", { clientX: 200, clientY: 200, button: 2 });
    pointer(h.el, "pointermove", { clientX: 400, clientY: 400 });

    expect(h.ctl.transform).toEqual({ x: 0, y: 0, scale: 1 });
    expect(h.el.setPointerCapture).not.toHaveBeenCalled();
    h.unmount();
  });

  it('does not start a pan from inside a [data-pan="ignore"] subtree', () => {
    const h = setup();
    const card = document.createElement("div");
    card.setAttribute("data-pan", "ignore");
    const inner = document.createElement("span");
    card.appendChild(inner);
    h.el.appendChild(card);

    // Dispatch from a descendant of the card — `closest` has to walk up.
    pointer(h.el, "pointerdown", { clientX: 200, clientY: 200, target: inner });
    pointer(h.el, "pointermove", { clientX: 400, clientY: 400 });

    expect(h.ctl.transform).toEqual({ x: 0, y: 0, scale: 1 });
    h.unmount();
  });

  it("ignores a zero-delta pointermove", () => {
    const h = setup();
    const setPointerCapture = h.el.setPointerCapture as ReturnType<typeof vi.fn>;

    pointer(h.el, "pointerdown", { clientX: 200, clientY: 200 });
    pointer(h.el, "pointermove", { clientX: 200, clientY: 200 });

    expect(setPointerCapture).toHaveBeenCalled();
    expect(h.ctl.transform).toEqual({ x: 0, y: 0, scale: 1 });
    h.unmount();
  });

  it("zoomBy anchors on the container centre", () => {
    const h = setup();

    act(() => h.ctl.zoomBy(2));

    // Centre is local (400, 300); the world point there must stay put.
    expect(h.ctl.transform.scale).toBe(2);
    expect(h.ctl.transform.x).toBe(400 - 400 * 2);
    expect(h.ctl.transform.y).toBe(300 - 300 * 2);
    h.unmount();
  });

  it("zoomBy clamps, and no-ops once clamped", () => {
    const h = setup({ maxScale: 2 });

    act(() => h.ctl.zoomBy(10));
    expect(h.ctl.transform.scale).toBe(2);

    const pinned = h.ctl.transform;
    act(() => h.ctl.zoomBy(10));
    expect(h.ctl.transform).toEqual(pinned);
    h.unmount();
  });

  it("reset returns to the initial transform", () => {
    const h = setup({ initial: { x: 5, y: 6, scale: 1.2 } });

    act(() => h.ctl.zoomBy(1.5));
    expect(h.ctl.transform).not.toEqual({ x: 5, y: 6, scale: 1.2 });

    act(() => h.ctl.reset());
    expect(h.ctl.transform).toEqual({ x: 5, y: 6, scale: 1.2 });
    h.unmount();
  });

  it("pins will-change during a gesture and clears it once idle", () => {
    const h = setup();
    expect(h.ctl.style.willChange).toBe("auto");

    wheel(h.el, -100, RECT.left + 10, RECT.top + 10);
    expect(h.ctl.style.willChange).toBe("transform");

    // A second gesture inside the window slides the timer rather than
    // re-flipping state, so the layer stays promoted throughout.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    wheel(h.el, -100, RECT.left + 10, RECT.top + 10);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(h.ctl.style.willChange).toBe("transform");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(h.ctl.style.willChange).toBe("auto");

    h.unmount();
  });

  it("unbinds its listeners on unmount", () => {
    const h = setup();
    const el = h.el;
    h.unmount();

    // No act() — a setState here would warn on an unmounted hook, and
    // the point is that nothing fires at all.
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
    expect(el.style.cursor).toBe("");
  });

  it("does nothing when the container ref was never attached", () => {
    // Guards the `if (!el) return` arms — a consumer that renders the
    // controller before mounting its container must not blow up.
    const { result } = renderHook(() => usePanZoom());
    expect(() => act(() => result.current.zoomBy(2))).not.toThrow();
    expect(result.current.transform).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("applies its transform to a real element via style", () => {
    function Canvas() {
      const ctl = usePanZoom({ initial: { x: 3, y: 4, scale: 1.5 } });
      return <div ref={ctl.containerRef} data-testid="canvas" style={ctl.style} />;
    }
    const { getByTestId } = render(<Canvas />);
    expect(getByTestId("canvas").style.transform).toBe(
      "translate(3px, 4px) scale(1.5)",
    );
  });
});
