import type { InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Chrome for the two unauthenticated pages, `/sign-in` and `/sign-up`.
 *
 * Those two clients carried parallel copies of all of it: the centered
 * card, the icon-tile header, five label+input pairs repeating the same
 * focus-ring class string, the AlertTriangle error row, and the submit
 * button with its Loader2 pending state. They still agree today, which
 * is the moment to make them share rather than the moment after one of
 * them has been restyled alone.
 *
 * What genuinely differs between the two pages is the fields and the
 * prose, so that stays at the call site; the furniture lives here.
 */
export function AuthCard({
  onSubmit,
  icon: Icon,
  title,
  description,
  children,
  footer,
}: {
  onSubmit: (e: React.FormEvent) => void;
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  /** Fields, the error row, and the submit button — in render order. */
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
 * One labelled input in an {@link AuthCard}.
 *
 * `first` drops the `mt-3` that separates a field from the one above it
 * — spelled out rather than inferred so a reordered form can't silently
 * lose or double its top margin. `mono` is for the `bv_u_` key field,
 * the only one whose value is machine-shaped.
 */
export function AuthField({
  id,
  label,
  first,
  mono,
  ...input
}: {
  id: string;
  label: string;
  first?: boolean;
  mono?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      <label
        className={cn("block text-xs font-medium text-foreground mb-1.5", !first && "mt-3")}
        htmlFor={id}
      >
        {label}
      </label>
      <input
        id={id}
        className={cn(
          "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring",
          mono && "font-mono",
        )}
        {...input}
      />
    </>
  );
}

/** The inline error row under an {@link AuthCard}'s fields. Renders nothing without a message. */
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
 * An {@link AuthCard}'s submit button, with the spinner swap while the
 * request is in flight.
 *
 * `disabled` takes the whole expression (not just the extra conditions)
 * because each page gates on different fields and both already include
 * `submitting` in it.
 */
export function AuthSubmit({
  icon: Icon,
  label,
  pendingLabel,
  submitting,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  pendingLabel: string;
  submitting: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="mt-5 w-full inline-flex items-center justify-center gap-1.5 h-9 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {submitting ? (
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
