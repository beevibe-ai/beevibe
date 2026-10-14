"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * A read-only link in a tinted box with a Copy button — the "here's the
 * link, send it to them" step of both invite flows.
 *
 * `user-widget`'s "Invite a teammate" and the room page's "Invite to room"
 * had each spelled this out: same box, same read-only input that
 * select-alls on focus, same button that flips to "Copied". Only the
 * caption above it differs, so that is the prop; the rest is fixed.
 *
 * Owns its own `useCopyToClipboard` rather than taking `copied`/`copy`
 * from the parent — in both call sites the box was the hook's only
 * consumer, so the "Copied" flash belongs to the box.
 */
export function CopyableLinkBox({ link, caption }: { link: string; caption: ReactNode }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{caption}</div>
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
