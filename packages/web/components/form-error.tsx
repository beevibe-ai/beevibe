import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The inline "something went wrong" line under a form field.
 *
 * Four forms — sign-in, sign-up, the rooms list and the room invite
 * dialog — each wrote out the same warning-triangle-plus-message row. The
 * spacing above it is the one thing that legitimately differs (it depends
 * on what the line sits under), so that comes in as `className`; the icon,
 * its size and the text treatment are the same everywhere.
 *
 * This is for a plain error string. `MutationError` is the different
 * thing it is sometimes confused with: that one takes a mutation and
 * renders a right-aligned "Couldn't <verb>: …" line.
 */
export function FormError({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex items-start gap-1.5 text-xs text-status-failed", className)}
    >
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Chrome for a full-width text input on a form. Nine inputs across the
 * auth pages, the rooms list and both invite dialogs spelled this out
 * character for character.
 */
export const FIELD_INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
