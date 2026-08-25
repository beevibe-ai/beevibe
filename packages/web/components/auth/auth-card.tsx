"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The centered credential card shared by `/sign-in` and `/sign-up`.
 *
 * The two pages ask for different things and route differently on success,
 * but the chrome around that — full-height centered `<main>`, the bordered
 * card `<form>`, the badge/title/blurb header, the labeled inputs, the
 * inline error row, the spinner-swapping submit button and the
 * "already have an account?" footer — was written out twice, verbatim down
 * to the Tailwind strings. Changing the field styling meant remembering
 * both files.
 *
 * These are presentational only: every page keeps its own state, its own
 * validation and its own submit handler.
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
  /** Sub-title prose under the heading. */
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
 * A labeled text input. `spaced` adds the top margin that separates it from
 * the field above — the first field in a card leaves it off.
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
  spaced?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      <label
        className={cn("block text-xs font-medium text-foreground mb-1.5", spaced && "mt-3")}
        htmlFor={id}
      >
        {label}
      </label>
      <input
        id={id}
        className={cn(
          "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring",
          className,
        )}
        {...input}
      />
    </>
  );
}

/** Inline validation / server-error row. Renders nothing when there's no error. */
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
 * Primary submit button. Swaps its icon for a spinner and its label for
 * `pendingLabel` while the request is in flight.
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
