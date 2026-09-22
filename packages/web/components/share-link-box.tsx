"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * Read-only URL with a Copy button — the panel both invite dialogs show
 * once they have a sign-up link to hand over (`UserWidget`'s "invite a
 * teammate" and the room page's "invite to room", which falls back to a
 * link when the invitee has no account yet).
 *
 * The two rendered the same box down to the class strings and the
 * `onFocus` select-all, differing only in the line of prose above it —
 * so that is the prop. Owning the `useCopyToClipboard` state here also
 * means the "Copied" flash can't be wired to the wrong value: the button
 * copies exactly the `link` it displays.
 */
export function ShareLinkBox({ link, children }: { link: string; children: ReactNode }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{children}</div>
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
