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
 *   <repo_card repo_url="..." stars="..." language="..." source="..."
 *              description="..." />
 *     Rendered as a rich card (stars, language badge, source tier pill,
 *     description). Use after find_repo results — one card per result
 *     instead of a markdown bullet list, so users see stars at a glance.
 *
 *   `task_*`, `agent_*`, `sess_*` ids inline in the visible text
 *     Hydrated as reference cards by the UI; collected as `view_refs`.
 */

import {
  extractGitHubRepoRefs,
  type ChatDirectives,
  type OpenView,
  type RepoCard,
  type SuggestedAction,
} from "@beevibe/core";

const ENTITY_ID_RE = /\b((?:task|agent|sess)_[A-Za-z0-9]{12})\b/g;
const OPEN_VIEW_RE =
  /<open_view\s+path="([^"]+)"(?:\s+label="([^"]+)")?\s*\/?>(?:\s*<\/open_view>)?/i;
// Tolerates any attribute order, self-closing or paired-with-inline-text.
// Group 1 = attributes; group 2 = inline body (used as description when
// the description="" attribute is absent).
const REPO_CARD_RE =
  /<repo_card\b([^>]*)>(?:([\s\S]*?)<\/repo_card>)?/gi;
const ATTR_REPO_URL_RE = /\brepo_url\s*=\s*"([^"]*)"/i;
const ATTR_STARS_RE = /\bstars\s*=\s*"([^"]*)"/i;
const ATTR_LANGUAGE_RE = /\blanguage\s*=\s*"([^"]*)"/i;
const ATTR_SOURCE_RE = /\bsource\s*=\s*"([^"]*)"/i;
const ATTR_DESCRIPTION_RE = /\bdescription\s*=\s*"([^"]*)"/i;
const VALID_REPO_SOURCES = new Set(["learned", "trending", "community", "github"]);

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

export interface ProcessedResponse extends ChatDirectives {
  /** Directive-stripped, ready for markdown render. */
  visible: string;
  /** Always present here — the parser emits `[]` rather than omitting it. */
  view_refs: string[];
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

  const repoCards: RepoCard[] = [];
  const seenRepoUrls = new Set<string>();
  for (const m of raw.matchAll(REPO_CARD_RE)) {
    const attrs = m[1] ?? "";
    const inline = m[2]?.trim();
    const repoUrl = attrs.match(ATTR_REPO_URL_RE)?.[1]?.trim();
    if (!repoUrl) continue;
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) continue;
    if (seenRepoUrls.has(parsed.canonical)) continue;
    seenRepoUrls.add(parsed.canonical);
    const starsRaw = attrs.match(ATTR_STARS_RE)?.[1]?.trim();
    const language = attrs.match(ATTR_LANGUAGE_RE)?.[1]?.trim();
    const sourceRaw = attrs.match(ATTR_SOURCE_RE)?.[1]?.trim().toLowerCase();
    const descAttr = attrs.match(ATTR_DESCRIPTION_RE)?.[1]?.trim();
    const description = descAttr || inline || undefined;
    const stars = starsRaw ? Number(starsRaw.replace(/[^\d]/g, "")) : undefined;
    const source =
      sourceRaw && VALID_REPO_SOURCES.has(sourceRaw)
        ? (sourceRaw as RepoCard["source"])
        : undefined;
    repoCards.push({
      repo_url: parsed.canonical,
      owner: parsed.owner,
      name: parsed.name,
      ...(Number.isFinite(stars) && stars! >= 0 ? { stars } : {}),
      ...(language ? { language } : {}),
      ...(source ? { source } : {}),
      ...(description ? { description } : {}),
    });
  }
  let visible = raw;
  if (openMatch) visible = visible.replace(OPEN_VIEW_RE, "");
  if (suggested_actions) visible = visible.replace(SUGGEST_ACTION_RE, "");
  if (repoCards.length > 0) visible = visible.replace(REPO_CARD_RE, "");
  visible = visible.trim();

  // Auto-promote bare github URLs so Try works when agents skip
  // <repo_card>. URLs stay in `visible` for the markdown renderer.
  for (const ref of extractGitHubRepoRefs(visible)) {
    if (seenRepoUrls.has(ref.url)) continue;
    seenRepoUrls.add(ref.url);
    repoCards.push({
      repo_url: ref.url,
      owner: ref.owner,
      name: ref.name,
    });
  }

  const repo_cards = repoCards.length > 0 ? repoCards : undefined;

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
    ...(repo_cards ? { repo_cards } : {}),
  };
}

/**
 * Extract owner/name from a GitHub URL and return a canonical
 * `https://github.com/<owner>/<name>` (no trailing path, no .git, lowercased
 * host). Returns undefined for anything that isn't a valid repo URL — the
 * caller drops the card so a malformed tag can't render an empty UI row.
 */
function parseRepoUrl(
  raw: string,
): { owner: string; name: string; canonical: string } | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return undefined;
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) return undefined;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    const owner = parts[0]!;
    const nameRaw = parts[1]!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nameRaw)) return undefined;
    const name = nameRaw.replace(/\.git$/i, "");
    return { owner, name, canonical: `https://github.com/${owner}/${name}` };
  } catch {
    return undefined;
  }
}
