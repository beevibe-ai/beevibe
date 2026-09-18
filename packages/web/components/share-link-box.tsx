"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * A copyable URL with a one-line explanation above it.
 *
 * Both invite dialogs end the same way — "here's a link, send it to them" —
 * and both had built the box by hand: the same read-only input that
 * select-alls on focus, the same Copy button flashing "Copied", the same
 * bordered muted container. Only the sentence above differed, and the two
 * had already drifted on the button's hit area.
 *
 * `hint` stays a prop rather than being derived from the link, because the
 * two dialogs are explaining genuinely different things: the teammate invite
 * says "send them this link", while the room invite has to explain *why* it
 * is showing a link at all (the invitee has no account yet).
 *
 * The input is read-only rather than disabled so the text stays selectable —
 * `useCopyToClipboard` is a no-op on a non-secure origin, and manual
 * select-and-copy is the fallback when it is.
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
