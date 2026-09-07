"use client";

import type { ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/**
 * The copyable-link panel both invite dialogs show once they have a
 * sign-up URL to hand over — "invite a teammate" in the user widget,
 * "invite to room" on the room page.
 *
 * It was written out twice: the same read-only select-on-focus input
 * next to the same Copy button, each dialog calling `useCopyToClipboard`
 * itself. Owning the hook here means the "Copied" flash belongs to the
 * box that was actually clicked, and a caller that grows a second link
 * can't accidentally share one flash between them.
 *
 * `description` is a node because the two dialogs explain the link
 * differently — the room one has to say the invitee will land in *this*
 * room — and that sentence is the only thing telling the user what they
 * are about to paste into a chat.
 */
export function ShareLinkBox({
  link,
  description,
}: {
  link: string;
  description: ReactNode;
}) {
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

/**
 * The sign-up URL an invite hands out.
 *
 * Both dialogs built this by hand off `window.location.origin`, and
 * they had to agree on the query parameter names because `/sign-up`
 * reads them: `email` pre-fills the field, `room` makes the new visitor
 * auto-join that room and land there instead of `/welcome`. Three call
 * sites for two names is enough for a typo to go unnoticed until an
 * invite silently drops someone on the wrong page.
 *
 * Returns "" during pre-render, where there is no origin to build on —
 * the dialogs are client-only, so this only shows up in tests.
 */
export function signUpInviteLink(email: string, roomId?: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const params = new URLSearchParams();
  if (roomId) params.set("room", roomId);
  params.set("email", email);
  return `${origin}/sign-up?${params.toString()}`;
}
