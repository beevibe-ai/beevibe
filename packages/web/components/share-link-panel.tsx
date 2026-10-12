"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * The "here's a link — copy it" panel both invite dialogs fall back to
 * when the invitee has no account yet.
 *
 * `InviteTeammateDialog` (user-widget) and `InviteDialog` (room detail)
 * had byte-identical copies of the bordered box, the read-only
 * select-on-focus input and the Copy button — along with their own
 * `useCopyToClipboard()` call to drive it. Only the one line of help copy
 * above the field ever differed, so that is what stays a prop.
 *
 * The clipboard hook lives in here rather than in each caller: the
 * "Copied" flash belongs to this button, and keeping the state next to it
 * means a dialog that renders the panel can't forget to wire it up.
 */
export function ShareLinkPanel({ link, children }: { link: string; children: ReactNode }) {
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
