"use client";

import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * A sign-up URL handed to someone who doesn't have an account yet, with a
 * copy button — the tail end of both invite flows.
 *
 * `InviteDialog` (room) and `InviteTeammateDialog` (user menu) reach it by
 * different routes: the room one only learns the invitee has no account
 * when `POST /rooms/:id/invite` comes back `person_not_found`, while the
 * teammate one never calls the API at all and builds the link as soon as
 * the typed address looks like an email. What they show at the end was
 * identical markup twice over, down to the select-on-focus and the
 * `h-7 px-2.5` button, so it lives here once.
 *
 * Select-on-focus matters more than it looks: `useCopyToClipboard` can
 * come back false on a non-secure origin or with clipboard permission
 * denied, and a link the user can select by tabbing to it is the fallback
 * that keeps a failed copy from being a dead end.
 */
export function ShareLinkBox({ description, link }: { description: string; link: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="mt-3 rounded border border-border bg-muted/40 p-3">
      <div className="text-[11px] text-muted-foreground mb-1.5">{description}</div>
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
