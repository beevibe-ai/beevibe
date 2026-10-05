"use client";

import type { ComponentProps, FormEvent, ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The chrome the two unauthenticated pages — `/sign-in` and `/sign-up` —
 * are built from.
 *
 * They are different flows (one retrieves an existing `bv_u_` key, the
 * other mints one) but the same *form*: a centered card, an icon badge over
 * a title and a blurb, a stack of labeled inputs, an inline error, a
 * submit button that swaps to a spinner, and a footer pointing at the other
 * page. Every one of those had been written out twice, down to the
 * `focus:ring-1 focus:ring-ring` on each input and the
 * `disabled:cursor-not-allowed` on each button — five inputs' worth of
 * identical class strings, which is how the two pages had already started
 * to drift apart visually.
 *
 * What stays at the call site is what actually differs: which fields
 * exist, what the submit handler does, and the copy.
 */

/**
 * The error both pages show when `NEXT_PUBLIC_BV_API_URL` isn't set, so
 * there is no api server to submit to. Shared because it is the same
 * misconfiguration with the same fix, and the user sees the wording.
 */
export const API_NOT_CONFIGURED = "Web isn't configured to talk to an api server.";

/** Centered card + header. `onSubmit` is wired to the enclosed `<form>`. */
export function AuthCard({
  icon: Icon,
  title,
  blurb,
  onSubmit,
  children,
}: {
  icon: LucideIcon;
  title: string;
  blurb: ReactNode;
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
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{blurb}</p>
        </header>
        {children}
      </form>
    </main>
  );
}

/**
 * Labeled text input. Every `<input>` attribute passes straight through, so
 * a field can still set its own `type`, `autoComplete`, `minLength` and so
 * on — this only owns the label markup and the shared input styling.
 *
 * `first` drops the top margin: the first field sits directly under the
 * header, which already has its own spacing.
 */
export function AuthField({
  id,
  label,
  first = false,
  className = "",
  ...input
}: { id: string; label: string; first?: boolean } & ComponentProps<"input">) {
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
        className={`w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring ${className}`}
        {...input}
      />
    </>
  );
}

/** Inline submit error. Renders nothing when `message` is null. */
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
 * Primary submit button. Swaps its icon and label for a spinner and
 * `busyLabel` while `submitting`, and is disabled whenever `submitting` is
 * true — so the call site's `disabled` only needs to express its own
 * field-validity rule.
 */
export function AuthSubmit({
  icon: Icon,
  label,
  busyLabel,
  submitting,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  busyLabel: string;
  submitting: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={submitting || disabled}
      className="mt-5 w-full inline-flex items-center justify-center gap-1.5 h-9 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {submitting ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {busyLabel}
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

/**
 * Secondary, non-submitting action under the primary button — currently
 * only sign-in's "switch to the other credential type" toggle, but it is
 * the same affordance either page would want.
 */
export function AuthAltAction({
  onClick,
  disabled = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-3 w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Rule + fine print pointing at the other auth page. */
export function AuthFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
      {children}
    </footer>
  );
}
