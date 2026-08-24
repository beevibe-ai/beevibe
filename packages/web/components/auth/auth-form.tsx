import type { InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The primitives the two unauthenticated pages — `/sign-in` and `/sign-up` —
 * are both built out of.
 *
 * The pages differ in what they submit (password vs. key vs. provisioning)
 * but not at all in how they look: the same centred card, the same labelled
 * input, the same warning-triangle error line, the same full-width submit
 * button with a spinner. Each was written out by hand twice, which is how
 * the two ended up one Tailwind class apart in places. The state, the
 * validation and the submit handlers stay on the pages — only the chrome
 * lives here.
 */

const INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * Centred card wrapping a form, with the icon badge / title / blurb header
 * both pages open with. `footer` is the "New here? Sign up" cross-link.
 */
export function AuthCard({
  icon: Icon,
  title,
  description,
  onSubmit,
  footer,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  onSubmit: (e: React.FormEvent) => void;
  footer: ReactNode;
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

        <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
          {footer}
        </footer>
      </form>
    </main>
  );
}

/**
 * A labelled input. `first` drops the top margin — fields are stacked, so
 * every one but the first sits `mt-3` below its predecessor.
 */
export function AuthField({
  id,
  label,
  first,
  className,
  ...input
}: {
  id: string;
  label: string;
  first?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      <label
        className={cn("block text-xs font-medium text-foreground mb-1.5", !first && "mt-3")}
        htmlFor={id}
      >
        {label}
      </label>
      <input id={id} className={cn(INPUT_CLASS, className)} {...input} />
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
 * Full-width submit button that swaps its icon + label for a spinner while
 * the request is in flight.
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
  disabled: boolean;
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
