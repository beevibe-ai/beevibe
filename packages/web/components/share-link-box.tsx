"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * A read-only URL with a Copy button, for the sign-up links the two
 * invite dialogs hand back — "invite a teammate" in the user widget and
 * "invite to room" on the room page.
 *
 * Both had built this inline from the same parts: the bordered well, the
 * select-on-focus readonly input, the Copy button that flips to "Copied",
 * and their own `useCopyToClipboard()` call. Only the note above the
 * field actually differed, so that is the one prop.
 *
 * Owning the hook here also drops a wart from the room dialog, which
 * held its link as `string | null` and so passed `copy(shareLink ?? "")`
 * — copying an empty string in a branch that can't be reached. A caller
 * now renders this only when it has a link, and the link is a `string`.
 */
export function ShareLinkBox({ link, note }: { link: string; note: ReactNode }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{note}</div>
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={link}
          className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-[11px] font-mono"
          // Select the whole URL on focus so a click-then-Cmd-C works for
          // anyone who ignores the button.
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
