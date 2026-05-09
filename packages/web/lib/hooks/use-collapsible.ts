"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Boolean state persisted to localStorage. SSR returns the default; the
 * stored value loads on mount to avoid hydration mismatch (a one-frame
 * flash when the persisted value differs is acceptable for chrome).
 */
export function useCollapsible(
  storageKey: string,
  defaultCollapsed = false,
): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === "true") setCollapsed(true);
      else if (raw === "false") setCollapsed(false);
    } catch {
      /* localStorage unavailable; stay on default */
    }
  }, [storageKey]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        /* localStorage unavailable; in-memory only */
      }
      return next;
    });
  }, [storageKey]);

  return [collapsed, toggle];
}
