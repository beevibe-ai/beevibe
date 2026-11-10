"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * The "send them this link" panel in the two invite dialogs: a hint line,
 * the link in a read-only monospace field that selects itself on focus,
 * and a Copy button that flashes "Copied".
 *
 * `useCopyToClipboard` already exists because all four copy buttons were
 * hand-rolling the flash timer; its doc comment names "the two invite
 * dialogs' share links" among its callers. The *markup* around those two
 * stayed duplicated — identical down to the `text-[11px] font-mono`
 * field and the `shrink-0` on the button — with only the hint text
 * differing. The hook now lives in here with it, so neither dialog has
 * to hold copy state it uses for nothing else.
 */
export function ShareLinkBox({ hint, link }: { hint: ReactNode; link: string }) {
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
