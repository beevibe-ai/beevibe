/**
 * Escaping for the XML-ish blocks we hand to agents.
 *
 * Several surfaces render tagged text into an agent's prompt — core-memory
 * `<block>` / `<fact>` elements in the memory briefing, `<mesh-ask>` /
 * `<mesh-negotiate>` / `<mesh-blocker>` envelopes in the mesh server. They all
 * need the same two escapes, and each had grown its own copy.
 *
 * Order matters: `&` MUST be replaced first, otherwise the ampersands
 * introduced by the later replacements get escaped a second time and `"`
 * renders as `&amp;quot;` instead of `&quot;`.
 */

/**
 * Escape a value going inside a double-quoted attribute — `name="..."`.
 * Covers `&`, `"`, `<` and `>`.
 */
export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape a value going in element text — `<block>...</block>`. Quotes are
 * legal in text content, so only `&`, `<` and `>` are escaped; leaving quotes
 * alone keeps agent-authored prose readable in the prompt.
 */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
