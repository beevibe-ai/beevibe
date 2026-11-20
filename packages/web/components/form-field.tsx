/**
 * The two class strings every hand-built text field in the app was
 * carrying inline.
 *
 * `TEXT_INPUT_CLASS` appeared character-for-character identical at nine
 * `<input>`/`<textarea>` sites across five files — both auth forms, the
 * two invite dialogs, the create-room form and the room composer — and
 * `FIELD_LABEL_CLASS` at seven `<label>`s. Same situation as
 * `PICKER_SELECT_CLASS` (#277): nine copies of a focus-ring treatment is
 * nine edits to restyle a field, and nine chances for one to be missed and
 * quietly look different.
 *
 * These are constants rather than a `<Field>` component on purpose. The
 * surrounding structure genuinely differs — the invite dialogs have no
 * label at all, sign-in swaps its whole field set on a mode toggle, the
 * create-room form sits its input beside a submit button — so a component
 * would have to take the layout as a parameter and would buy nothing over
 * the class it wraps. What repeated was the styling, so that is what moves.
 *
 * One near-copy is deliberately left inline: the room composer's textarea
 * is `flex-1` in a flex row rather than a `w-full` field in a stack, so it
 * is a different layout primitive that happens to share a border and a
 * focus ring. Routing it through this constant would mean overriding the
 * width back off again, which is harder to read than the duplication.
 */

/** Full-width bordered text input with the app's focus ring. */
export const TEXT_INPUT_CLASS =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm " +
  "focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * Block label above a field. Callers add their own top margin — the first
 * label in a stack has none and the rest carry `mt-3` — via `cn()`.
 */
export const FIELD_LABEL_CLASS = "block text-xs font-medium text-foreground mb-1.5";
