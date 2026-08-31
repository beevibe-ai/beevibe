import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The text-input chrome shared by every hand-written form in the app.
 *
 * `sign-in`, `sign-up`, the rooms list, the room invite dialog and the
 * user widget each carried this exact 12-utility string — nine copies,
 * character for character, with nothing but a `cn()` call between some
 * of them. A form control is precisely the thing that must not drift:
 * two inputs a user sees in one session at different heights or with
 * different focus rings reads as a bug, and the only thing that had
 * been keeping them equal was that nobody had edited one.
 *
 * Exported as a class string rather than an `<Input>` component on
 * purpose. The call sites disagree on almost everything else — `type`,
 * `autoComplete`, `inputMode`, `autoFocus`, `minLength`, `spellCheck`,
 * whether they're controlled by a `useState` or a mutation's pending
 * flag — so a wrapper would be all passthrough props. Compose it with
 * `cn()` when a field needs an addition (`font-mono` for the API-key
 * field).
 */
export const FIELD_INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * The label above a {@link FIELD_INPUT_CLASS} input.
 *
 * `mt` is the top margin, which is the only thing that varied across
 * the seven copies: the first field in a form sits flush, every
 * subsequent one takes `mt-3`.
 */
export function FieldLabel({
  htmlFor,
  mt = false,
  children,
}: {
  htmlFor: string;
  /** Add the `mt-3` gap used between stacked fields. */
  mt?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("block text-xs font-medium text-foreground mb-1.5", mt && "mt-3")}
    >
      {children}
    </label>
  );
}

/**
 * The inline "that didn't work" row under a form — warning triangle
 * plus the server's message. Renders nothing for a null/empty message,
 * so callers drop it in without a surrounding conditional.
 *
 * `className` carries the caller's spacing (`mt-3` under the auth
 * forms, `mb-4` above the rooms list) because the block sits below the
 * field in one layout and above it in the other.
 *
 * Distinct from `<MutationError>`, which is the right-aligned
 * "Couldn't <verb>: …" line used beside action buttons — same color
 * token, different affordance.
 */
export function FormError({
  message,
  className,
}: {
  message: string | null | undefined;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div className={cn("flex items-start gap-1.5 text-xs text-status-failed", className)}>
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/**
 * The full-width primary submit at the foot of the auth forms, with the
 * spinner-swap while in flight.
 *
 * `sign-in` and `sign-up` had this button's 15-utility class string
 * byte-identical, along with the `{submitting ? <Loader2 …/> : <Icon
 * …/>}` swap. What differs is only the icon and the two labels, so
 * those are the props.
 */
export function SubmitButton({
  submitting,
  disabled,
  pendingLabel,
  icon,
  children,
}: {
  submitting: boolean;
  disabled: boolean;
  /** Label shown while `submitting` — "Signing in…", "Provisioning…". */
  pendingLabel: string;
  /** The idle-state icon, already sized (`h-3.5 w-3.5`). */
  icon: ReactNode;
  children: ReactNode;
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
          {icon}
          {children}
        </>
      )}
    </button>
  );
}
