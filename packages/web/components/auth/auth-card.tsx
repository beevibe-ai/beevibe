import type { ComponentType, FormEvent, ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The shared chrome of the two credential forms, `/sign-in` and `/sign-up`.
 *
 * Both pages are the same centered card — icon badge, title, blurb, a stack
 * of labelled inputs, an error line, a submit button, a footer pointing at
 * the other page — and every class string below was character-for-character
 * identical in both files before this module existed. What actually differs
 * is the copy, the icons, and which fields are on screen, so that is what
 * these components take as props.
 *
 * Deliberately not abstracted here: form state and submit handling. Sign-in
 * has two modes (password / paste-a-key) that swap the handler and the field
 * set; sign-up has the invite-link flow. Pulling that into a shared
 * controller would mean one component with both pages' logic inside it,
 * which is the opposite of the point.
 */

/** Centered page + card + form element. `onSubmit` is wired to the form. */
export function AuthCard({
  onSubmit,
  children,
}: {
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-background">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-card border border-border rounded-lg p-6 shadow-sm"
      >
        {children}
      </form>
    </main>
  );
}

/**
 * Icon badge, title, and blurb. `blurb` is a node rather than a string
 * because both pages set `<span className="font-mono">bv_u_</span>` inside
 * the prose.
 */
export function AuthCardHeader({
  icon: Icon,
  title,
  blurb,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  blurb: ReactNode;
}) {
  return (
    <header className="mb-5">
      <div className="inline-flex items-center justify-center h-10 w-10 rounded-md bg-primary text-primary-foreground mb-3">
        <Icon className="h-5 w-5" />
      </div>
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{blurb}</p>
    </header>
  );
}

/**
 * One labelled input. Renders label + input as siblings in a fragment —
 * no wrapper element — because the vertical rhythm comes from the label's
 * own `mt-3` and a wrapper would change the spacing.
 *
 * `first` drops that `mt-3`: the top field in the stack sits flush against
 * the header, which already carries `mb-5`.
 *
 * `mono` is for the `bv_u_` key field, the only input rendered in the mono
 * face. Remaining `<input>` attributes (`type`, `autoComplete`,
 * `inputMode`, `minLength`, `spellCheck`, `autoFocus`) pass straight
 * through — they vary per field and the browser's autofill behavior depends
 * on getting them exactly right.
 */
export function AuthField({
  id,
  label,
  value,
  onChange,
  first = false,
  mono = false,
  className,
  ...inputProps
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  first?: boolean;
  mono?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange">) {
  return (
    <>
      <label
        className={cn("block text-xs font-medium text-foreground mb-1.5", !first && "mt-3")}
        htmlFor={id}
      >
        {label}
      </label>
      {/* `inputProps` is spread ahead of the controlled props so a caller
          cannot accidentally shadow `value` / `onChange` / the base classes.
          The order also keeps the emitted attribute order identical to the
          hand-written markup this replaced. */}
      <input
        id={id}
        {...inputProps}
        className={cn(
          "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring",
          mono && "font-mono",
          className,
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}

/** The inline failure line. Renders nothing when there is no message. */
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
 * The primary submit button. Swaps its icon + label for a spinner +
 * `busyLabel` while the request is in flight; `submitting` also forces it
 * disabled, so callers pass only their own field-validity condition as
 * `disabled`.
 */
export function AuthSubmitButton({
  submitting,
  disabled = false,
  icon: Icon,
  label,
  busyLabel,
}: {
  submitting: boolean;
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  busyLabel: string;
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

/** Rule + fine print under the button, pointing at the other auth page. */
export function AuthCardFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="mt-5 pt-4 border-t border-border/60 text-[11px] text-muted-foreground leading-relaxed">
      {children}
    </footer>
  );
}

/**
 * The error both pages show when `NEXT_PUBLIC_API_URL` is unset, so there is
 * no api server to post credentials to. Sign-in checks it in each of its two
 * submit handlers and sign-up in its one, and all three had the sentence
 * written out — the same drift risk as the detail-page "not configured"
 * copy that `DetailGate` centralized.
 */
export const API_NOT_CONFIGURED_MESSAGE = "Web isn't configured to talk to an api server.";
