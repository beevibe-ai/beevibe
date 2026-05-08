/**
 * Display directives the chat surface understands. Both /chat and
 * /room invoke agents that emit these tags; both routes call
 * `processResponse` here so the parsing rules stay in one place.
 *
 *   <open_view path="..." label="..." />
 *     Resolved to an "Open this →" CTA below the bubble.
 *
 *   <suggest_action label="..." prompt="..." />
 *   <suggest_action>inline text</suggest_action>
 *     Each becomes a clickable chip; click sends `prompt` (or `label`,
 *     or the inline text). Multiple per turn allowed.
 *
 *   `task_*`, `agent_*`, `sess_*` ids inline in the visible text
 *     Hydrated as reference cards by the UI; collected as `view_refs`.
 */

const ENTITY_ID_RE = /\b((?:task|agent|sess)_[A-Za-z0-9]{12})\b/g;
const OPEN_VIEW_RE =
  /<open_view\s+path="([^"]+)"(?:\s+label="([^"]+)")?\s*\/?>(?:\s*<\/open_view>)?/i;

/**
 * Paths the chat UI knows how to navigate to. The system prompt names
 * these explicitly, but the prompt is best-effort guidance, not
 * enforcement. A misbehaving model could emit `path="/admin/..."` or
 * `path="https://attacker.example/..."` — we drop the directive when
 * the path doesn't start with one of these prefixes so the UI never
 * renders an off-spec CTA.
 */
const ALLOWED_OPEN_VIEW_PREFIXES = [
  "/tasks",
  "/agents",
  "/mesh",
  "/memory",
  "/promotions",
  "/dashboard",
  "/sessions",
] as const;

function isAllowedOpenViewPath(path: string): boolean {
  // Must be an absolute in-app path, no scheme, no protocol-relative,
  // no traversal. The prefix check then narrows to known surfaces.
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("..")) return false;
  return ALLOWED_OPEN_VIEW_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
// Tolerates: any attribute order, self-closing or paired, inline-text form.
// Group 1 = attributes; group 2 = inline text (when paired).
const SUGGEST_ACTION_RE =
  /<suggest_action\b([^>]*)>(?:([\s\S]*?)<\/suggest_action>)?/gi;
const ATTR_LABEL_RE = /\blabel\s*=\s*"([^"]*)"/i;
const ATTR_PROMPT_RE = /\bprompt\s*=\s*"([^"]*)"/i;

export interface SuggestedAction {
  /** Short text shown on the chip. */
  label: string;
  /** Optional fuller text sent on click — defaults to label. */
  prompt?: string;
}

export interface OpenView {
  path: string;
  label?: string;
}

export interface ProcessedResponse {
  /** Directive-stripped, ready for markdown render. */
  visible: string;
  /** Entity ids referenced inline (e.g. task_xxx, agent_yyy). */
  view_refs: string[];
  open_view?: OpenView;
  suggested_actions?: SuggestedAction[];
}

export function processResponse(raw: string): ProcessedResponse {
  const openMatch = raw.match(OPEN_VIEW_RE);
  const open_view: OpenView | undefined =
    openMatch?.[1] && isAllowedOpenViewPath(openMatch[1])
      ? { path: openMatch[1], ...(openMatch[2] ? { label: openMatch[2] } : {}) }
      : undefined;

  const suggestedActions: SuggestedAction[] = [];
  const seenLabels = new Set<string>();
  for (const m of raw.matchAll(SUGGEST_ACTION_RE)) {
    const attrs = m[1] ?? "";
    const inline = m[2]?.trim();
    const attrLabel = attrs.match(ATTR_LABEL_RE)?.[1]?.trim();
    const attrPrompt = attrs.match(ATTR_PROMPT_RE)?.[1]?.trim();
    // Three valid forms:
    //   <suggest_action label="X" prompt="Y" />        → label=X, prompt=Y
    //   <suggest_action label="X" />                   → label=X, prompt=undef
    //   <suggest_action>X</suggest_action>             → label=X, prompt=undef
    //   <suggest_action label="X">Y</suggest_action>   → label=X, prompt=Y
    const label = attrLabel ?? inline;
    const prompt = attrPrompt ?? (attrLabel && inline ? inline : undefined);
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    suggestedActions.push(prompt ? { label, prompt } : { label });
  }
  const suggested_actions = suggestedActions.length > 0 ? suggestedActions : undefined;

  let visible = raw;
  if (openMatch) visible = visible.replace(OPEN_VIEW_RE, "");
  if (suggested_actions) visible = visible.replace(SUGGEST_ACTION_RE, "");
  visible = visible.trim();

  const seen = new Set<string>();
  const view_refs: string[] = [];
  for (const m of visible.matchAll(ENTITY_ID_RE)) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      view_refs.push(id);
    }
  }

  return {
    visible,
    view_refs,
    ...(open_view ? { open_view } : {}),
    ...(suggested_actions ? { suggested_actions } : {}),
  };
}
