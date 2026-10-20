"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * Read-only link with a copy button, under a line of explanatory text.
 *
 * The companion to `ModalOverlay`: both invite dialogs — "invite a
 * teammate" in the user widget and "invite to room" on the room page —
 * fall back to handing the user a sign-up URL to pass along, and both
 * had a byte-identical copy of this block, down to the
 * select-on-focus that makes the link grabbable without the button and
 * the `shrink-0` that stops the button collapsing beside a long URL.
 * Only the `label` above it differs.
 *
 * `useCopyToClipboard` lives here rather than in the callers: its
 * `copied` flag belongs to this button and neither dialog used it for
 * anything else.
 */
export function ShareLinkBox({ label, link }: { label: ReactNode; link: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{label}</div>
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={link}
          className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-[11px] font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          onClick={() => void copy(link)}
          className="h-7 px-2.5 rounded text-[11px] font-medium border border-border hover:bg-secondary transition-colors cursor-pointer shrink-0"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
