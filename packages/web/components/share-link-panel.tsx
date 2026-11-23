"use client";

import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * The "send them this link" panel shown after an invite produces a
 * sign-up URL: a read-only, select-on-focus input plus a Copy button
 * that flips to "Copied".
 *
 * `room-detail-client`'s invite dialog and `user-widget`'s
 * invite-a-teammate dialog rendered this identically — same container,
 * same input, same button, same class lists — differing only in the
 * caption above it. Both also kept their own `useCopyToClipboard` purely
 * to feed this block, so the hook moves in here with it.
 */
export function ShareLinkPanel({
  caption,
  link,
}: {
  /** Explains what the link does; the two dialogs word it differently. */
  caption: React.ReactNode;
  link: string;
}) {
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
