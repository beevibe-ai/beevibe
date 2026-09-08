"use client";

import { AlertTriangle } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

/**
 * The hand-written form controls, in one place.
 *
 * The app has no component library — controls are Tailwind class strings
 * written inline at each call site. That is fine until the same string is
 * written ten times: the sign-in / sign-up forms, the two invite dialogs and
 * the room-create form all spelled out the identical input chrome, and the
 * three inline error rows were byte-identical bar their margin. Restyling a
 * field then meant finding every copy, and a missed one drifted silently.
 *
 * These are deliberately thin — a class constant and the two or three
 * elements that always travel together — not a general design system. The
 * richer controls that already have a home (`chip.tsx`, the pickers'
 * `PICKER_SELECT_CLASS`, `ModalOverlay`, `MutationError`) stay where they
 * are; this covers the plain form primitives that had none.
 */

/**
 * Text-input chrome shared by every plain form field. Pass extra classes
 * through `TextField`'s `className` — it merges via `cn`, so a caller can
 * add `font-mono` or override a single property without restating the rest.
 */
export const FIELD_INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

/** Label chrome for a {@link TextField}. */
export const FIELD_LABEL_CLASS = "block text-xs font-medium text-foreground mb-1.5";

/**
 * A labelled text input, rendered as a bare `<label>` + `<input>` pair (no
 * wrapper element) so it drops into the existing forms without changing
 * their layout — the forms space their fields with `mt-3` on the *label*,
 * which `labelClassName` carries.
 *
 * `label` is optional: the invite dialogs have a single self-evident field
 * and render the input alone.
 */
export function TextField({
  label,
  labelClassName,
  className,
  id,
  ...input
}: {
  label?: ReactNode;
  /** Extra classes for the label — in practice the `mt-3` field spacing. */
  labelClassName?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      {label ? (
        <label className={cn(FIELD_LABEL_CLASS, labelClassName)} htmlFor={id}>
          {label}
        </label>
      ) : null}
      <input id={id} className={cn(FIELD_INPUT_CLASS, className)} {...input} />
    </>
  );
}

/**
 * The warning-triangle error row a form shows under its fields.
 *
 * Callers own the margin (`mt-3` under a field, `mb-4` under a form) and
 * pass it via `className`, because it depends on what the row sits between.
 */
export function InlineFormError({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-1.5 text-xs text-status-failed", className)}>
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/**
 * The "here's a link to send them" panel both invite dialogs show once the
 * invitee turns out not to have an account: a read-only, select-on-focus
 * input holding the URL, and a Copy button that flashes "Copied".
 *
 * Owns its own {@link useCopyToClipboard} — both call sites used the hook
 * for this and nothing else, so the flash state belongs with the button
 * rather than with the dialog.
 *
 * `blurb` differs between the two (the room dialog explains they'll land in
 * the room), so it stays a prop.
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
