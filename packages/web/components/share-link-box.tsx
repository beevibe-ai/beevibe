"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * A copyable link in a bordered box, with a lead line above it.
 *
 * Both invite dialogs — "Invite to room" in `rooms/[id]` and "Invite a
 * teammate" in the user widget — end at the same place: a sign-up URL the
 * user is meant to send to someone. Each had its own copy of the box, the
 * select-on-focus input, the copy button and its own `useCopyToClipboard`,
 * differing only in the sentence above the link.
 */
export function ShareLinkBox({ lead, link }: { lead: ReactNode; link: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{lead}</div>
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
