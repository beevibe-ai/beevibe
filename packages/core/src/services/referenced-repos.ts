/**
 * Mine a closed task's session transcript + work products for GitHub repo
 * URLs the agent actually used. Powers the "Save as team capability" card
 * on the task detail page: when an audit-style task wraps up, we surface
 * the repos the agent looked at so the user can promote them to learned
 * skills without trusting the agent to call `use_repo` itself.
 *
 * Why mine the session instead of nudging the agent in prompt:
 *   By the time an audit closes, the model's attention is exhausted and a
 *   "don't forget to call use_repo!" reminder gets dropped. Mining is
 *   deterministic — runs server-side, costs zero prompt tokens, and never
 *   forgets.
 */

import type { SessionRepository } from "../ports/session-repo.js";
import type { SessionEventRepository } from "../ports/session-event-repo.js";
import type { WorkProductRepository } from "../ports/work-product-repo.js";
import type { LearnedSkillRepository } from "../ports/repo-run-repo.js";

export interface ReferencedRepo {
  owner: string;
  name: string;
  /** Canonical `https://github.com/<owner>/<name>` (no trailing path). */
  url: string;
  /** Times this URL appeared across all transcript sources. */
  occurrences: number;
  /** True if the caller already has a learned_skill pointing at this URL. */
  already_saved: boolean;
}

export interface ReferencedReposDeps {
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  workProductRepo: WorkProductRepository;
  learnedSkillRepo: LearnedSkillRepository;
}

// Repo root only — owner/name are alphanumeric + dot/hyphen/underscore in
// GitHub's schema. We deliberately STOP at the second path segment, so
// `/owner/repo/blob/main/CLAUDE.md` collapses to the repo root. The
// boundary class (`[\s)"',<>]|$`) keeps trailing punctuation out.
const GITHUB_URL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=[/\s)"',<>]|$)/g;

// Paths under github.com that aren't repos. github.com/orgs/foo, settings,
// marketplace, etc. — filter at the owner segment, not the URL.
const NON_REPO_OWNERS = new Set([
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

// Common false-positive `name` values that show up when a regex sweeps
// commit metadata or download URLs (`github.com/owner/repo.git`, raw
// fragments, etc.). `.git` is the only common one — strip it.
function normalizeName(raw: string): string {
  return raw.replace(/\.git$/i, "");
}

function extractFromString(text: string): Array<{ owner: string; name: string; url: string }> {
  const out: Array<{ owner: string; name: string; url: string }> = [];
  if (!text) return out;
  GITHUB_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GITHUB_URL_RE.exec(text)) !== null) {
    const owner = match[1];
    const nameRaw = match[2];
    if (!owner || !nameRaw) continue;
    if (NON_REPO_OWNERS.has(owner.toLowerCase())) continue;
    const name = normalizeName(nameRaw);
    if (!name) continue;
    out.push({
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
    });
  }
  return out;
}

/**
 * Returns deduplicated GitHub repo URLs referenced in the task's sessions
 * and work products, sorted by occurrence count (descending).
 *
 * `ownerId` scopes the `already_saved` lookup — pass the human caller's
 * person id so we don't surface a repo that's already in their team's
 * learned-skill registry.
 */
export async function getReferencedRepos(
  taskId: string,
  ownerId: string,
  deps: ReferencedReposDeps,
): Promise<ReferencedRepo[]> {
  // Sessions tied to this task — both the originating chat/task session
  // and any follow-up runs (e.g. nested use_repo container tasks).
  const sessions = await deps.sessionRepo.listForTask(taskId);
  const sources: string[] = [];

  for (const session of sessions) {
    const events = await deps.sessionEventRepo.listBySession(session.id);
    for (const ev of events) {
      // `content` carries the tool input (tool_call), result (tool_result),
      // or assistant message (agent). All three can cite a repo URL.
      if (ev.content) sources.push(ev.content);
    }
  }

  // Work products attached to the task — the agent's final summary/body
  // often cites the URL even when the tool calls didn't (e.g. WebFetched
  // a raw subpath but reported the repo root in prose).
  const products = await deps.workProductRepo.listByTask(taskId);
  for (const wp of products) {
    if (wp.summary) sources.push(wp.summary);
    if (wp.url) sources.push(wp.url);
  }
  // listByTask omits `body` for size — fetch full row only when we need it.
  for (const wp of products) {
    if (wp.body_bytes && wp.body_bytes > 0) {
      const full = await deps.workProductRepo.findById(wp.id);
      if (full?.body) sources.push(full.body);
    }
  }

  // Aggregate by canonical URL.
  const tally = new Map<string, { owner: string; name: string; url: string; count: number }>();
  for (const src of sources) {
    for (const hit of extractFromString(src)) {
      const prior = tally.get(hit.url);
      if (prior) {
        prior.count += 1;
      } else {
        tally.set(hit.url, { owner: hit.owner, name: hit.name, url: hit.url, count: 1 });
      }
    }
  }

  if (tally.size === 0) return [];

  // Mark already-saved entries so the UI can dim them.
  const owned = await deps.learnedSkillRepo.listByOwner(ownerId);
  const savedUrls = new Set(owned.map((s) => s.repo_url.replace(/\/$/, "")));

  const repos: ReferencedRepo[] = Array.from(tally.values())
    .map((t) => ({
      owner: t.owner,
      name: t.name,
      url: t.url,
      occurrences: t.count,
      already_saved: savedUrls.has(t.url),
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  return repos;
}
