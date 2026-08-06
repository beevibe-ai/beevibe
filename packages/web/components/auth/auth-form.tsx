"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";

/**
 * The centered card the two unauthenticated pages are built out of.
 *
 * `/sign-in` and `/sign-up` are the same form: a card with an icon badge, a
 * title, a blurb, a stack of labelled inputs, an error line, a submit button
 * and a footer link to the other page. Both had it written out by hand, which
 * meant six copies of the same twelve-line label+input pair and two copies of
 * every wrapper class. Drift between them is directly user-visible — these are
 * the first two screens anyone sees — so the shell lives here once.
 *
 * What is genuinely different stays at the call site: sign-in's
 * password/paste-key mode toggle, sign-up's invite-room handling, and each
 * page's copy.
 */
export function AuthCard({
  icon: Icon,
  title,
  blurb,
  onSubmit,
  children,
  footer,
}: {
  icon: LucideIcon;
  title: string;
  blurb: ReactNode;
  onSubmit: (e: React.FormEvent) => void;
  children: ReactNode;
  footer: ReactNode;
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
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{blurb}</p>
        </header>

        {children}

        <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
          {footer}
        </footer>
      </form>
    </main>
  );
}

/**
 * A labelled text input inside an {@link AuthCard}.
 *
 * `first` drops the top margin — every field after the first in a stack is
 * separated by `mt-3`, and spelling that out per call site is what let the two
 * pages diverge on spacing. Remaining input attributes (`type`,
 * `autoComplete`, `minLength`, …) pass straight through.
 */
export function AuthField({
  id,
  label,
  first = false,
  className = "",
  ...input
}: {
  id: string;
  label: string;
  first?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      <label
        className={`block text-xs font-medium text-foreground mb-1.5${first ? "" : " mt-3"}`}
        htmlFor={id}
      >
        {label}
      </label>
      <input
        id={id}
        className={`w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring${
          className ? ` ${className}` : ""
        }`}
        {...input}
      />
    </>
  );
}

/** The inline failure line under the fields. Renders nothing when `message` is null. */
export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-3 flex items-start gap-1.5 text-xs text-status-failed">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/**
 * The card's primary action. Swaps to a spinner and `pendingLabel` while the
 * request is in flight, and is disabled for the whole of it — `disabled` is
 * OR-ed with `pending` so call sites only express their own validity rule.
 */
export function AuthSubmitButton({
  icon: Icon,
  label,
  pendingLabel,
  pending,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  pendingLabel: string;
  pending: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
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
