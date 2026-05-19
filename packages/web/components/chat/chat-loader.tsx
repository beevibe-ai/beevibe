/**
 * Spinning icosahedron loader shown in the agent reply column before
 * the first streamed text or tool step lands. 20 triangular faces
 * built from CSS borders; the whole solid rotates on three axes via a
 * single `spin` keyframe. Styles live in globals.css under
 * `.bv-chat-loader` (the `.solid` / `.side` selectors are scoped by
 * that ancestor so they can't leak).
 *
 * Adapted from a Uiverse loader by an anonymous author; the original
 * was authored against styled-components, ported here to plain CSS so
 * it slots into the project's globals.css pattern with no new dep.
 */
const FACES = Array.from({ length: 20 }, (_, i) => i + 1);

/**
 * @param compact - 18px variant for the inline "thinking…" indicator
 *   next to tool steps. Default 40px is for the empty reply column.
 */
export function ChatLoader({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`bv-chat-loader${compact ? " compact" : ""}`}
      role="status"
      aria-label="Agent is thinking"
    >
      <div className="solid">
        {FACES.map((n) => (
          <div key={n} className="side" />
        ))}
      </div>
    </div>
  );
}
