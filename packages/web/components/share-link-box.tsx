"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * A read-only URL with a copy button, under a line of explanation.
 *
 * Both invite flows end here — the "invite a teammate" modal in the user
 * widget and the room invite modal, when the invitee has no account yet —
 * and both had spelled out the same select-on-focus input, copy button and
 * "Copied" toggle. Only the blurb above it differs, so that's the prop.
 *
 * Owns its own copy state: nothing outside cares whether the button has
 * flipped to "Copied", and giving each box its own hook keeps two boxes on
 * one page from flipping together.
 */
export function ShareLinkBox({ url, children }: { url: string; children: ReactNode }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{children}</div>
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={url}
          className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-[11px] font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          onClick={() => void copy(url)}
          className="h-7 px-2.5 rounded text-[11px] font-medium border border-border hover:bg-secondary transition-colors cursor-pointer shrink-0"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
