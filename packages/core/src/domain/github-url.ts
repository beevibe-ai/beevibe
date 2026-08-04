/**
 * Recognizing GitHub repo URLs in free text, in one place.
 *
 * Two callers sweep model-authored prose for repo links and they must agree,
 * because the URL one produces is matched against the URL the other stored:
 *
 *   - `api/routes/directives.ts` auto-promotes a bare URL in an agent's
 *     visible text into a `<repo_card>`, so the user gets a Try button even
 *     when the model emitted a plain markdown link.
 *   - `core/services/referenced-repos.ts` mines a closed task's transcript
 *     for the repos the agent actually used, and looks each one up against
 *     the learned-skill registry to mark it `already_saved`.
 *
 * Both carried a byte-identical copy of the regex and of the 20-entry
 * `NON_REPO_OWNERS` set. Adding a new non-repo path (GitHub ships them —
 * `sponsors`, `codespaces`) to one copy and not the other would leave the
 * two disagreeing about what counts as a repo, and the disagreement would
 * surface as a card that never matches a saved skill rather than as an
 * error.
 */

/**
 * Repo root only. `owner` and `name` follow GitHub's schema (alphanumeric
 * plus dot/hyphen/underscore, first char alphanumeric). We deliberately STOP
 * at the second path segment, so `/owner/repo/blob/main/CLAUDE.md` collapses
 * to the repo root. The trailing boundary class keeps closing punctuation
 * out of `name`.
 *
 * Global — callers using `.exec()` in a loop must reset `lastIndex` first,
 * which is why {@link extractGitHubRepoRefs} exists rather than each site
 * driving the regex by hand.
 */
export const GITHUB_REPO_URL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=[/\s)"',<>]|$)/g;

/**
 * First-segment paths under github.com that aren't owners —
 * `github.com/orgs/foo`, `/settings`, `/marketplace`, etc. Filtered at the
 * owner segment rather than against the whole URL.
 */
export const NON_REPO_OWNERS: ReadonlySet<string> = new Set([
  "orgs",
  "settings",
  "marketplace",
  "topics",
  "trending",
  "features",
  "pricing",
  "search",
  "notifications",
  "issues",
  "pulls",
  "explore",
  "about",
  "contact",
  "site",
  "security",
  "login",
  "signup",
  "logout",
  "new",
]);

/** A repo reference found in free text, with its canonical root URL. */
export interface GitHubRepoRef {
  owner: string;
  name: string;
  /** `https://github.com/<owner>/<name>` — always the repo root. */
  url: string;
}

/**
 * Strip the suffixes that ride along when a regex sweeps prose rather than
 * structured metadata:
 *
 *   - `.git`, from clone URLs (`github.com/owner/repo.git`).
 *   - trailing periods, from a URL that ends a sentence. `.` is a legal
 *     `name` character, so the regex happily takes the full stop with it and
 *     yields `repo.` — a URL that 404s and never matches a stored repo.
 */
function normalizeName(raw: string): string {
  return raw.replace(/\.git$/i, "").replace(/\.+$/, "");
}

/**
 * Every GitHub repo root cited in `text`, in the order it appears.
 *
 * Duplicates are NOT collapsed — callers want different things from a repeat
 * mention (directives dedups to one card; referenced-repos counts occurrences
 * to rank), so deduping is left to them.
 */
export function extractGitHubRepoRefs(text: string): GitHubRepoRef[] {
  const out: GitHubRepoRef[] = [];
  if (!text) return out;
  GITHUB_REPO_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GITHUB_REPO_URL_RE.exec(text)) !== null) {
    const owner = match[1];
    const nameRaw = match[2];
    if (!owner || !nameRaw) continue;
    if (NON_REPO_OWNERS.has(owner.toLowerCase())) continue;
    const name = normalizeName(nameRaw);
    if (!name) continue;
    out.push({ owner, name, url: `https://github.com/${owner}/${name}` });
  }
  return out;
}
