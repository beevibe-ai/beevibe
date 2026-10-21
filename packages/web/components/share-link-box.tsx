"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * A read-only link with a Copy button, under a one-line explanation.
 *
 * The other half of the job `modal-overlay.tsx` started: both invite
 * dialogs — "invite a teammate" in the user widget and "invite to room" on
 * the room page — carried a byte-identical copy of this block, down to the
 * select-on-focus handler and the `copied ? "Copied" : "Copy"` label, and
 * each called `useCopyToClipboard` only to feed it. Only the hint text
 * differs, so that is what the dialogs pass in.
 */
export function ShareLinkBox({ link, hint }: { link: string; hint: ReactNode }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{hint}</div>
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
