import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The bordered single-line input used across the forms — sign-in, sign-up,
 * the room creator, the invite modals. Eight hand-written copies of this
 * 9-class string, which is eight places the focus ring can drift from the
 * rest.
 */
export const INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm " +
  "focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * A labelled text input. `id` is required rather than generated because the
 * label's `htmlFor` is what makes the pair clickable, and every call site
 * already had an id for autofill to key off.
 *
 * `className` lands on the wrapper (the forms space their fields with
 * `mt-3`, the room creator stretches its field with `flex-1`);
 * `inputClassName` extends the input itself, which only the paste-your-key
 * field needs — it adds `font-mono` so a `bv_u_` key stays legible.
 */
export function TextField({
  id,
  label,
  className,
  inputClassName,
  ...input
}: {
  id: string;
  label: string;
  className?: string;
  inputClassName?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-foreground mb-1.5">
        {label}
      </label>
      <input id={id} className={cn(INPUT_CLASS, inputClassName)} {...input} />
    </div>
  );
}
