"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long the "copied" confirmation stays up. */
const RESET_MS = 1500;

/**
 * Copy-to-clipboard with a "copied" flash, for the four buttons that
 * want exactly that: the id chip in the peek-panel footers, the shell
 * command blocks, and the two invite dialogs' share links.
 *
 * Each had its own `setCopied(true); setTimeout(() => setCopied(false),
 * 1500)`, and they disagreed on the parts that matter:
 *
 * - `navigator.clipboard` is undefined on non-secure origins and older
 *   browsers. `command-block.tsx` checked for it; `click-to-copy-id.tsx`
 *   did not, so a click there raised an unhandled rejection instead of
 *   doing nothing. Guarded here for everyone.
 * - The write can reject even when the API exists (permission denied).
 *   Two of the four caught that; two didn't.
 * - None of them cleared the timer on unmount, so closing the panel
 *   inside the flash window set state on an unmounted component.
 *
 * `copy` resolves to whether the write actually landed, for callers
 * that want to say something when it didn't. The text stays selectable
 * either way, so a failed copy is a soft failure, not a dead end.
 */
export function useCopyToClipboard(): {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    if (!text) return false;
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), RESET_MS);
    return true;
  }, []);

  return { copied, copy };
}
