"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

/**
 * The three form primitives the auth and invite surfaces had each spelled
 * out by hand: a labeled text input, an inline error row, and a
 * copyable share-link box.
 *
 * They were duplicated across five files — `sign-in`, `sign-up`,
 * `rooms-list`, the room `InviteDialog` and the user-widget
 * `InviteTeammateDialog` — and the duplication was in the *class
 * strings*, which is the worst kind: an 80-character Tailwind literal
 * repeated nine times renders identically until someone tweaks one copy,
 * and then two inputs on adjacent screens quietly stop matching. There
 * is no type error and no test failure to catch that.
 */

const INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * A bare text input carrying the shared styling. All props forward, so
 * callers keep setting `type`, `autoComplete`, `autoFocus`, `minLength`,
 * `disabled` etc. directly; `className` is merged rather than replaced,
 * for the one caller that adds `font-mono` to the key field.
 *
 * Use {@link TextField} instead wherever there is a visible label — this
 * is for the two invite dialogs, where a heading and a paragraph of
 * explanatory copy already stand in for one.
 */
export function TextInput({
  className,
  ...inputProps
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(INPUT_CLASS, className)} {...inputProps} />;
}

/**
 * {@link TextInput} with its label. `id` wires the two together, so it
 * is required rather than optional.
 *
 * `labelClassName` exists for the same reason `InlineError` takes a
 * `className`: these fields stack, and the second and subsequent ones in
 * a stack carry a `mt-3` on the *label*. That is the caller's layout
 * decision, not the field's.
 */
export function TextField({
  id,
  label,
  labelClassName,
  ...inputProps
}: {
  id: string;
  label: string;
  labelClassName?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      <label
        className={cn("block text-xs font-medium text-foreground mb-1.5", labelClassName)}
        htmlFor={id}
      >
        {label}
      </label>
      <TextInput id={id} {...inputProps} />
    </>
  );
}

/**
 * Inline validation / request error, with the warning glyph.
 *
 * Renders nothing for a null message so callers can drop the
 * `{error ? … : null}` ternary that wrapped every copy.
 *
 * `className` carries the caller's spacing, which is the one thing that
 * legitimately differs between sites (`mt-3` under a form field, `mb-4`
 * above a list). It is not baked in, because a shared component that
 * imposes its own margins is a component every caller has to fight.
 */
export function InlineError({
  message,
  className,
}: {
  message: string | null | undefined;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div className={cn("flex items-start gap-1.5 text-xs text-status-failed", className)}>
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/**
 * A read-only URL with a Copy button, under a line of explanatory text.
 *
 * Both invite dialogs land here when the invitee has no account yet:
 * "we can't add them directly, so here's a link to send them." The
 * input is focus-to-select as well as click-to-copy, because the copy
 * button needs a clipboard permission the user may have denied.
 */
export function ShareLinkBox({
  hint,
  link,
  className,
}: {
  hint: ReactNode;
  link: string;
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className={cn("rounded border border-border bg-muted/40 p-3", className)}>
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
