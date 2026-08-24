"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * The read-only URL field with a Copy button that both invite dialogs show
 * once they have a sign-up link to hand over — `UserWidget`'s "Invite a
 * teammate" and the room detail page's "Invite to room".
 *
 * The two had the same twenty lines of markup and their own copy of the
 * `useCopyToClipboard` wiring; only the sentence above the field differed,
 * so that is the one thing left as a prop. Owning the hook here also means
 * neither dialog carries copy state it uses nowhere else.
 *
 * The input stays focusable and select-on-focus: `copy` is a no-op on
 * non-secure origins, so manual selection has to keep working.
 */
export function ShareLinkBox({ blurb, link }: { blurb: ReactNode; link: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{blurb}</div>
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
