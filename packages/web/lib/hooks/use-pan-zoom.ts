"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface PanZoomTransform {
  x: number;
  y: number;
  scale: number;
}

interface PanZoomOptions {
  minScale?: number;
  maxScale?: number;
  /**
   * Initial transform. Defaults to identity (origin top-left, scale 1);
   * the caller is expected to absolute-position content relative to a
   * 50%/50% canvas anchor so the orbits land in the middle without
   * needing a translate offset baked in here.
   */
  initial?: Partial<PanZoomTransform>;
}

export interface PanZoomController {
  /** Attach to the outer (clipping) container. Wheel + pointer down land here. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** CSS transform + will-change to apply to the inner content. */
  style: {
    transform: string;
    transformOrigin: string;
    willChange: "transform" | "auto";
  };
  /** Reset to initial transform. */
  reset: () => void;
  /** Programmatically zoom in/out by a step (e.g. for +/- buttons). */
  zoomBy: (factor: number) => void;
  /** Current transform — exposed for badge-style readouts. */
  transform: PanZoomTransform;
}

/**
 * Pan/zoom for an absolutely-positioned canvas. The container clips;
 * the inner content is transformed.
 *
 * Zoom: wheel (or trackpad pinch, which Safari/Chrome surface as
 * `wheel` events with `ctrlKey`). Anchored on the cursor so the spot
 * under the pointer stays fixed across zoom — feels natural, the way
 * Figma / Excalidraw / Miro work.
 *
 * Pan: pointer-down on the background and drag. We don't start a pan
 * if the pointer started on a child marked with `data-pan="ignore"` —
 * that's how the agent cards opt out so a click on a card never
 * accidentally drags the canvas underneath them.
 */
export function usePanZoom(opts: PanZoomOptions = {}): PanZoomController {
  const minScale = opts.minScale ?? 0.4;
  const maxScale = opts.maxScale ?? 2.5;
  // Memoized so `reset`'s useCallback dep stays stable across renders;
  // otherwise reset's identity churns and consumers re-bind handlers.
  const initial = useMemo<PanZoomTransform>(
    () => ({
      x: opts.initial?.x ?? 0,
      y: opts.initial?.y ?? 0,
      scale: opts.initial?.scale ?? 1,
    }),
    [opts.initial?.x, opts.initial?.y, opts.initial?.scale],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<PanZoomTransform>(initial);

  // Stash the latest transform in a ref so wheel/pointer handlers
  // (which are bound once) see fresh values without needing re-bind.
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // `will-change: transform` promotes the inner layer onto the GPU
  // compositor so pan/zoom is cheap — but the layer is rasterized once
  // and bitmap-scaled, so text and 1px borders blur at any non-1 scale.
  // Pin it on only during active interaction; clear it ~200ms after the
  // last gesture so the browser re-rasterizes at the displayed size and
  // content snaps pixel-crisp at rest.
  const [interacting, setInteracting] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markInteracting = useCallback(() => {
    // Pointermove can fire at 120Hz — keep the per-event work minimal.
    // Only flip state on the leading edge; otherwise just slide the
    // idle timer forward.
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    } else {
      setInteracting(true);
    }
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      setInteracting(false);
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  // ── Wheel: zoom around cursor ──────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // ctrlKey is the trackpad-pinch signal on macOS/Windows. Treat
      // both real wheel and pinch as "zoom intent" — the canvas should
      // never accidentally scroll the page.
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const cur = transformRef.current;
      // Smaller per-tick step keeps zoom feeling smooth on trackpads
      // (which fire wheel events at 60Hz with small deltaY values).
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = clamp(cur.scale * factor, minScale, maxScale);
      if (next === cur.scale) return;

      // Anchor zoom on the cursor: the world-space point under the
      // cursor should stay under the cursor after the scale changes.
      // worldX = (cx - x) / scale ⇒ newX = cx - worldX * newScale.
      const worldX = (cx - cur.x) / cur.scale;
      const worldY = (cy - cur.y) / cur.scale;
      setTransform({
        x: cx - worldX * next,
        y: cy - worldY * next,
        scale: next,
      });
      markInteracting();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [minScale, maxScale, markInteracting]);

  // ── Pointer drag: pan ──────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pointerId = -1;

    const onPointerDown = (e: PointerEvent) => {
      // Skip middle/right click — let those go to native handling
      // (text selection, context menu) instead of starting a pan.
      if (e.button !== 0) return;
      // Cards opt out so clicks on them never drag the canvas.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-pan="ignore"]')) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      pointerId = e.pointerId;
      el.setPointerCapture(pointerId);
      el.style.cursor = "grabbing";
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (dx === 0 && dy === 0) return;
      lastX = e.clientX;
      lastY = e.clientY;
      const cur = transformRef.current;
      setTransform({ x: cur.x + dx, y: cur.y + dy, scale: cur.scale });
      markInteracting();
    };

    const stopDragging = () => {
      if (!dragging) return;
      dragging = false;
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        /* ignore — pointer may already be released */
      }
      el.style.cursor = "";
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", stopDragging);
    el.addEventListener("pointercancel", stopDragging);
    el.addEventListener("pointerleave", stopDragging);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", stopDragging);
      el.removeEventListener("pointercancel", stopDragging);
      el.removeEventListener("pointerleave", stopDragging);
    };
  }, [markInteracting]);

  const reset = useCallback(() => {
    setTransform(initial);
    markInteracting();
  }, [initial, markInteracting]);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Centered anchor for button-driven zoom — feels intentional
      // since there's no cursor to anchor against.
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const cur = transformRef.current;
      const next = clamp(cur.scale * factor, minScale, maxScale);
      if (next === cur.scale) return;
      const worldX = (cx - cur.x) / cur.scale;
      const worldY = (cy - cur.y) / cur.scale;
      setTransform({
        x: cx - worldX * next,
        y: cy - worldY * next,
        scale: next,
      });
      markInteracting();
    },
    [minScale, maxScale, markInteracting],
  );

  return {
    containerRef,
    style: {
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
      transformOrigin: "0 0",
      willChange: interacting ? "transform" : "auto",
    },
    reset,
    zoomBy,
    transform,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
