"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Dismiss-on-Escape + dismiss-on-click-outside, for the overlay
 * surfaces that all want exactly this: the agent and task peek panels,
 * the user-widget menu, and the chip pickers on the agent list.
 *
 * Each of those had its own copy — same two listeners, same
 * `ref.current.contains(e.target)` test, same document-level binding so
 * focus doesn't have to be on a focusable element inside the surface.
 *
 * Two details worth keeping straight, both of which the copies got
 * right and a fifth copy might not:
 *
 * - `mousedown`, not `click`. A click fires after the button that
 *   opened the surface has already been released; mousedown lets the
 *   surface close before the underlying element reacts.
 * - The listener attaches when `enabled` flips true, so the very click
 *   that opened the surface — which fired before this effect ran —
 *   can't race-trigger a dismiss.
 *
 * Callbacks are read through a ref, so passing inline arrows doesn't
 * re-bind the listeners on every render.
 */
export function useDismissOnOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onDismiss: () => void,
  opts: {
    /** False while the surface is closed. Defaults to true. */
    enabled?: boolean;
    /**
     * Escape handler, when it needs to do more than dismiss — the chip
     * pickers also return focus to their trigger. Defaults to
     * `onDismiss`.
     */
    onEscape?: () => void;
  } = {},
): void {
  const { enabled = true, onEscape } = opts;

  const handlers = useRef({ onDismiss, onEscape });
  handlers.current = { onDismiss, onEscape };

  useEffect(() => {
    if (!enabled) return;

    const onMouseDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      handlers.current.onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const { onEscape: escape, onDismiss: dismiss } = handlers.current;
      (escape ?? dismiss)();
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, ref]);
}
