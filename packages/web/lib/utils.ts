import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The single-line text/email/password field in the auth forms and the
 * invite dialogs.
 *
 * Eight inputs across five files carried this exact 13-class string
 * inline — the sign-in and sign-up fields, the two invite dialogs' email
 * inputs, and the room-name field. A field that looks different from its
 * neighbours reads as a bug, so the focus ring and the border colour want
 * one definition; `PICKER_SELECT_CLASS` is the same arrangement for the
 * agent-setting pickers' selects.
 *
 * Pass it through `cn()` with the extra classes when a call site needs to
 * add to it, so tailwind-merge resolves the conflicts.
 */
export const TEXT_INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
