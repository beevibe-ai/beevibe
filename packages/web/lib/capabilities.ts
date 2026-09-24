/**
 * Shared helpers for the capability-network surfaces (chat repo_cards,
 * /capabilities trending + search rows, /capabilities/runs playground,
 * /tasks save-as-capability flow).
 *
 * Lives in /lib because all of capabilities-client, chat-client,
 * run-detail-client, and task-detail-client import these — keeping
 * one copy avoids the drift bugs we kept hitting when each surface
 * had its own slightly-different `defaultTryGoal` / `formatStars`.
 */

/**
 * Repo-URL display helpers.
 *
 * `capabilities-client.tsx` and `run-card.tsx` each had a local
 * `repoName(url)` doing `url.replace("https://github.com/", "").split("/")`
 * — and they returned *different things* under the same name: the former
 * the bare repo segment, the latter `owner/repo`. `capabilities-client` then
 * hand-rolled the split a third time to pull the owner out. Naming the three
 * results separately is the point: whichever one a new call site wants, it
 * now has to say so.
 *
 * Only the `https://github.com/` prefix is stripped, matching what the api
 * stores in `repo_url`. Anything else passes through, which is why each
 * helper degrades to a prefix of the raw input rather than throwing.
 */
function stripRepoHost(url: string): string {
  return url.replace("https://github.com/", "");
}

/** `https://github.com/sst/opencode` → `"opencode"`. */
export function repoShortName(url: string): string {
  const parts = stripRepoHost(url).split("/");
  return parts[1] ?? parts[0] ?? url;
}

/** `https://github.com/sst/opencode` → `"sst/opencode"`. */
export function repoFullName(url: string): string {
  return stripRepoHost(url).split("/").slice(0, 2).join("/");
}

/** `https://github.com/sst/opencode` → `"sst"`; `""` when there is no owner segment. */
export function repoOwner(url: string): string {
  return stripRepoHost(url).split("/")[0] ?? "";
}

/** Stars formatter: 1234 → "1.2k", 18500 → "19k". */
export function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 64);
}

/**
 * Strip leading emoji and gemoji shortcodes (`:books:`) from a repo
 * description before showing it in a UI row. Trending JSON sometimes
 * ships emoji-decorated descriptions ("🤖 Your AI assistant"); we
 * drop the leader so rows align on text.
 */
export function cleanRepoDescription(desc: string | null | undefined): string | undefined {
  if (!desc) return undefined;
  const out = desc
    .replace(/^[\s\p{Extended_Pictographic}]+/u, "")
    .replace(/^:[a-z_]+:\s*/i, "")
    .trim();
  return out || undefined;
}

/**
 * Build the default `use_repo` goal for a one-click Try. The chat
 * repo_card variant has no `goal_pattern`; the /capabilities search
 * variant uses the learned-skill's curated pattern when present.
 */
export function defaultTryGoal(opts: {
  owner: string;
  name: string;
  description?: string | null;
  goal_pattern?: string;
}): string {
  const head = `Show me what ${opts.owner}/${opts.name} does and how to use it.`;
  if (opts.goal_pattern) return `${head} Match: ${opts.goal_pattern}`;
  const desc = opts.description?.trim();
  if (!desc) return head;
  const trimmed = desc.length > 160 ? desc.slice(0, 157) + "…" : desc;
  return `${head} Context: ${trimmed}`;
}
