"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * A read-only link with a Copy button, in a tinted box under a one-line
 * explanation.
 *
 * Both invite dialogs — "invite a teammate" in the user widget and "invite to
 * room" on the room page — end at the same place: an email that has no
 * beevibe account yet, and a `/sign-up?...` URL to hand the invitee instead.
 * Each had the box written out inline, identical down to the class strings
 * and the select-on-focus handler, with only the blurb above it differing.
 *
 * Owns its own copy state so the two call sites don't each have to hold a
 * `useCopyToClipboard` for it.
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
