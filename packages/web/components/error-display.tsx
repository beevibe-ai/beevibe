import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The two shapes a user-facing failure takes in this app, in one place.
 *
 * Both were written out by hand at every call site, and the copies had
 * drifted in exactly the ways hand-copied Tailwind does: the warning icon was
 * `h-3.5 w-3.5` in four of the five inline rows and `h-3 w-3` in the fifth,
 * and the utility order varied enough (`text-xs text-status-failed flex` vs
 * `flex items-start gap-1.5 text-xs`) that the rows read as deliberately
 * different when they were meant to be the same row.
 *
 * Only the outer spacing genuinely differs between call sites — a row under a
 * form field wants `mt-2`, one above a list wants `mb-4` — so that is the one
 * thing `className` carries. `cn` merges it, so a caller can still override a
 * base utility when it really needs to.
 *
 * Not to be confused with `MutationError`, which is a different thing: it
 * derives its own "Couldn't <verb>: <message>" prose from a react-query
 * mutation. These two take the message they are given.
 */

/**
 * A single-line failure under a field or above a list: warning icon, then the
 * message. No container — it sits in the flow of whatever it is reporting on.
 */
export function InlineError({
  message,
  className,
}: {
  message: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-1.5 text-xs text-status-failed", className)}>
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/**
 * A boxed failure with a headline and the underlying error text: for failures
 * that interrupt something the user was doing (a message that didn't send, an
 * agent that couldn't be reached) and so need to be legible at a glance in a
 * scrolling transcript.
 *
 * `detail` is the raw error message, deliberately muted — the headline is
 * what the user acts on, the detail is what they'd paste into a bug report.
 */
export function ErrorPanel({
  title,
  detail,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-status-failed/40 bg-status-failed/5 p-3 text-xs",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-status-failed font-medium mb-1">
        <AlertTriangle className="h-3.5 w-3.5" />
        {title}
      </div>
      {detail ? <div className="text-muted-foreground">{detail}</div> : null}
    </div>
  );
}
