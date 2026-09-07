"use client";

import type { FormEvent, InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The chrome shared by `/sign-in` and `/sign-up`.
 *
 * The two pages are the same card — centered on an otherwise empty
 * screen, an icon badge over a title and blurb, a stack of labelled
 * inputs, an inline error, a spinner-on-submit button, and a footer
 * pointing at the other page. They were built as two copies of that
 * markup, which meant every Tailwind class in it existed twice: the
 * input ring, the button's disabled states, the error row's icon size.
 * Nudging the form's look meant finding and editing both, and a miss
 * showed up as the two auth pages quietly drifting apart.
 *
 * What is *not* shared is the behavior: sign-in has two modes (password
 * and paste-a-key) with their own validation, sign-up has the invite
 * flow. Those stay in the page clients. This module is markup only —
 * every piece here is a shape both pages already rendered identically.
 */

/**
 * The input class both pages repeat on every field. Exported because
 * the key field on `/sign-in` renders it plus `font-mono`, which it
 * passes through `AuthField`'s `className`; nothing else should need
 * it directly.
 */
export const AUTH_INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * Full-screen centered card, rendered as the form itself so Enter
 * submits. `icon` sits in the badge above `title`; `description` is the
 * blurb under it, taken as a node because both pages put inline markup
 * in theirs (a `<span className="font-mono">bv_u_</span>`, an escaped
 * apostrophe).
 */
export function AuthCard({
  icon: Icon,
  title,
  description,
  onSubmit,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-background">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-card border border-border rounded-lg p-6 shadow-sm"
      >
        <header className="mb-5">
          <div className="inline-flex items-center justify-center h-10 w-10 rounded-md bg-primary text-primary-foreground mb-3">
            <Icon className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{description}</p>
        </header>
        {children}
      </form>
    </main>
  );
}

/**
 * A labelled input. Every other prop lands on the `<input>`, so callers
 * keep their own `type`, `autoComplete`, `minLength`, `autoFocus` and
 * handlers.
 *
 * `spaced` adds the `mt-3` that separates a field from the one above
 * it. It is a flag rather than something inferred from position because
 * the fields are written out one by one in the page clients (and on
 * `/sign-in` which fields exist at all depends on the mode), so there
 * is no list for a wrapper to walk.
 */
export function AuthField({
  id,
  label,
  spaced,
  className,
  ...input
}: {
  id: string;
  label: string;
  /** Add the top margin that separates this field from the one above. */
  spaced?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      <label
        className={cn("block text-xs font-medium text-foreground mb-1.5", spaced && "mt-3")}
        htmlFor={id}
      >
        {label}
      </label>
      <input id={id} {...input} className={cn(AUTH_INPUT_CLASS, className)} />
    </>
  );
}

/** Inline validation / request error, under the fields. */
export function AuthError({ message }: { message: string }) {
  return (
    <div className="mt-3 flex items-start gap-1.5 text-xs text-status-failed">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/**
 * The primary submit button, swapping its icon and label for a spinner
 * while the request is in flight. `pendingLabel` is separate from
 * `label` because the two pages say different things there ("Signing
 * in…" / "Verifying…" / "Provisioning…") and it is the only feedback a
 * user gets that the click registered.
 */
export function AuthSubmitButton({
  icon: Icon,
  label,
  pending,
  pendingLabel,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  pending: boolean;
  pendingLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="mt-5 w-full inline-flex items-center justify-center gap-1.5 h-9 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        <>
          <Icon className="h-3.5 w-3.5" />
          {label}
        </>
      )}
    </button>
  );
}

/** Rule-and-fine-print block at the bottom of the card. */
export function AuthCardFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
      {children}
    </footer>
  );
}
