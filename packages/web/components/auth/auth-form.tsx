"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";

/**
 * The card chrome `/sign-in` and `/sign-up` are both built out of.
 *
 * The two pages differ in what they collect and what they do with it, but
 * the frame around that — centered card, badge + title + blurb header,
 * labelled inputs, error note, pending-aware submit, footer link — was the
 * same markup written twice, down to the class strings. Tailwind classes
 * copy-pasted between two files is how the two halves of one flow end up
 * looking subtly different; keeping the chrome in one place means a change
 * to the field or button styling lands on both by construction.
 *
 * Only the chrome lives here. Auth logic, validation and copy stay on the
 * pages, which is where the two genuinely diverge.
 */

const INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

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
  /** Sub-title prose under the heading. Rich, so pages can inline `<code>`-ish spans. */
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
 * A labelled text input. `first` drops the top margin for the field that
 * opens the stack — the pages used to encode that by leaving `mt-3` off the
 * first label by hand.
 */
export function AuthField({
  id,
  label,
  value,
  onChange,
  disabled,
  first,
  className,
  ...input
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  first?: boolean;
  /** Extra classes appended to the shared input styling (e.g. `font-mono`). */
  className?: string;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "id" | "value" | "onChange" | "className"
>) {
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={className ? `${INPUT_CLASS} ${className}` : INPUT_CLASS}
        {...input}
      />
    </>
  );
}

/** Inline failure note under the fields. Renders nothing when `message` is falsy. */
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
 * Primary submit. Swaps its icon + label for a spinner while `pending`,
 * and is disabled whenever `pending` is set so a double-submit can't mint
 * two sessions.
 */
export function AuthSubmitButton({
  icon: Icon,
  label,
  pendingLabel,
  pending,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  pendingLabel: string;
  pending: boolean;
  /** Extra reason to disable (empty fields). ORed with `pending`. */
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
