"use client";

import type { FormEvent, ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";

/**
 * The card `/sign-in` and `/sign-up` are both built out of.
 *
 * The two pages had the same page shell, the same header (icon badge,
 * title, blurb), the same labeled inputs, the same error banner and the
 * same submit button written out twice — five copies of one 90-character
 * `className` between them, and two copies of the pending-vs-idle button
 * body. What actually differs between the pages is the fields and what
 * submitting does, which is what stays in the page.
 *
 * The pieces are separate exports rather than one do-everything component
 * because sign-in renders two different field sets (password mode and
 * paste-your-key mode) inside the same card.
 */

/** Shared input styling — the one place the form's text-field look lives. */
const FIELD_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

interface AuthCardProps {
  icon: LucideIcon;
  title: string;
  /** Prose under the title. Rich rather than string — both pages inline `<span className="font-mono">`. */
  blurb: ReactNode;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
  /** Message from a failed submit, rendered above the button. */
  error?: string | null;
  submit: {
    label: string;
    icon: LucideIcon;
    /** Label while the request is in flight; the spinner replaces `icon`. */
    pendingLabel: string;
    pending: boolean;
    disabled: boolean;
  };
  /** Optional link-style button between submit and footer (sign-in's mode switch). */
  secondary?: ReactNode;
  footer: ReactNode;
}

export function AuthCard({
  icon: Icon,
  title,
  blurb,
  onSubmit,
  children,
  error,
  submit,
  secondary,
  footer,
}: AuthCardProps) {
  const SubmitIcon = submit.icon;
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

        {error ? (
          <div className="mt-3 flex items-start gap-1.5 text-xs text-status-failed">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={submit.pending || submit.disabled}
          className="mt-5 w-full inline-flex items-center justify-center gap-1.5 h-9 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submit.pending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {submit.pendingLabel}
            </>
          ) : (
            <>
              <SubmitIcon className="h-3.5 w-3.5" />
              {submit.label}
            </>
          )}
        </button>

        {secondary}

        <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
          {footer}
        </footer>
      </form>
    </main>
  );
}

interface AuthFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  inputMode?: "email";
  autoFocus?: boolean;
  spellCheck?: boolean;
  minLength?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes on the input — the key field adds `font-mono`. */
  inputClassName?: string;
  /** Adds the top margin every field after the first one carries. */
  spaced?: boolean;
}

/** A labeled text input. Six of these existed across the two pages. */
export function AuthField({
  id,
  label,
  value,
  onChange,
  type = "text",
  inputClassName,
  spaced,
  ...input
}: AuthFieldProps) {
  return (
    <>
      <label
        className={`block text-xs font-medium text-foreground mb-1.5${spaced ? " mt-3" : ""}`}
        htmlFor={id}
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClassName ? `${FIELD_CLASS} ${inputClassName}` : FIELD_CLASS}
        {...input}
      />
    </>
  );
}

/**
 * The message both pages show when `NEXT_PUBLIC_BV_API_URL` is unset and
 * the user submits anyway. Distinct from `lib/api/messages` — that copy
 * addresses a page that can't load, this one a form that can't post.
 */
export const AUTH_API_NOT_CONFIGURED = "Web isn't configured to talk to an api server.";
