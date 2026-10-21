import { cn } from "@/lib/utils";

/**
 * Text-input chrome, identical across the sign-in and sign-up forms, both
 * invite dialogs, the room-create field and the room composer — ten copies
 * of the same class string, so a change to the focus ring meant ten edits.
 * Mirrors `PICKER_SELECT_CLASS`, which does the same for the card pickers'
 * `<select>`s.
 *
 * Width is deliberately not included: most callers want `w-full`, the room
 * composer wants `flex-1`. Compose through `cn` so a caller can also add or
 * override a utility (`font-mono`, `resize-none`).
 */
export const TEXT_INPUT_CLASS = cn(
  "rounded border border-border bg-background px-3 py-2 text-sm",
  "focus:outline-none focus:ring-1 focus:ring-ring",
);
