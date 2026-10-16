"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";

/**
 * Shared chrome for the two unauthenticated forms, `/sign-in` and
 * `/sign-up`.
 *
 * The pages are different flows — one retrieves an existing `bv_u_` key,
 * the other mints a person — but they were wearing the same clothes: the
 * centered viewport wrapper, the card, the icon badge, the title and blurb,
 * the inline error, the spinner-swapping submit button. Every class string
 * among those was character-for-character identical in both files, so the
 * next auth surface (reset-password, accept-invite) can now get the look
 * for free instead of by copy-paste.
 *
 * What stays with the pages is their logic: which fields they show, what
 * they do with the response, and how they word their errors.
 */
export function AuthCard({
  icon: Icon,
  title,
  blurb,
  onSubmit,
  children,
}: {
  /** Badge glyph above the title. Swaps per mode on the sign-in page. */
  icon: LucideIcon;
  title: string;
  /** One or two sentences under the title. */
  blurb: ReactNode;
  onSubmit: (e: React.FormEvent) => void;
  /** Fields, error, submit button, mode toggle, footer — in that order. */
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

/** The inline form error, or nothing when there isn't one. */
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
 * The card's primary button: `icon` + `label` at rest, a spinner +
 * `pendingLabel` while the request is in flight. `pending` also disables it,
 * so a slow network can't produce two signups from one impatient visitor.
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
  /** Extra reason to disable — typically "required fields still empty". */
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

/** Both pages' "/" footer line, under a hairline rule. */
export function AuthCardFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
      {children}
    </footer>
  );
}

/**
 * What both pages say when `isApiConfigured` is false. It was written out
 * three times across the two files (sign-in checks it in each of its two
 * submit paths), so the wording is pinned here.
 */
export const API_NOT_CONFIGURED = "Web isn't configured to talk to an api server.";
