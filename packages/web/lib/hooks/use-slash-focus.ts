"use client";

import { useEffect, type RefObject } from "react";

/**
 * Bind `/` (alone, no modifier) to focus + select the given input.
 * Standard convention across GitHub, Linear, Notion search bars.
 *
 * No-op when the user is already typing — text fields and
 * contenteditable surfaces own the keystroke. Modifier keys (⌘/, ⌃/)
 * also bypass so they don't fight browser-native bindings.
 */
export function useSlashFocus(ref: RefObject<HTMLInputElement>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}
