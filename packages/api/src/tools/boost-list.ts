/**
 * Curated boost list for the find_repo ranker.
 *
 * Two sources, tried in order:
 *
 *   1. Remote: `<CAPABILITIES_BASE_URL>/boost-list.json` (default points
 *      at the public beevibe-ai/beevibe-capabilities repo on
 *      raw.githubusercontent.com). This is the source of truth — edits
 *      land there via PR and every beevibe instance sees the same list
 *      after a restart.
 *
 *   2. Disk fallback: bundled `<repoRoot>/skills/beevibe-discover-repo/
 *      boost-list.json` if the remote fetch fails. Keeps offline /
 *      airgapped dev working.
 *
 * Loaded once at server startup; no periodic refresh. To pull a new
 * entry without redeploying, just restart the api process.
 *
 * Tests pass an in-memory array directly via {@link inMemoryBoostList}
 * to bypass both paths.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface BoostEntry {
  repo_url: string;
  goal_keywords: readonly string[];
  language: string;
  category: string;
}

export interface BoostList {
  entries(): readonly BoostEntry[];
}

const DEFAULT_CAPABILITIES_BASE_URL =
  "https://raw.githubusercontent.com/beevibe-ai/beevibe-capabilities/main/data";

const REMOTE_FETCH_TIMEOUT_MS = 5_000;

export function inMemoryBoostList(entries: readonly BoostEntry[]): BoostList {
  return { entries: () => entries };
}

export interface BoostListLoaderOptions {
  /** Bundled disk fallback path; usually `<repoRoot>` of the consumer. */
  repoRoot: string;
  /** Override for tests / private mirrors. */
  remoteUrl?: string;
  /** Override for tests; defaults to global fetch. */
  fetcher?: typeof fetch;
}

/**
 * Resolve the boost list at startup. Tries remote first, falls back to
 * disk, and finally returns an empty list (the ranker degrades to its
 * other tiers). Logs the chosen source so misconfigurations surface in
 * dev logs.
 */
export async function loadBoostList(opts: BoostListLoaderOptions): Promise<BoostList> {
  const remoteUrl =
    opts.remoteUrl ??
    process.env.BEEVIBE_CAPABILITIES_BASE_URL ??
    DEFAULT_CAPABILITIES_BASE_URL;
  const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);

  const remote = await fetchBoostListRemote(`${remoteUrl}/boost-list.json`, fetcher);
  if (remote) {
    console.log(
      `[find_repo] boost-list: loaded ${remote.length} entries from ${remoteUrl}/boost-list.json`,
    );
    return inMemoryBoostList(remote);
  }

  const disk = await loadBoostListFromDisk(opts.repoRoot);
  if (disk.entries().length > 0) {
    console.warn(
      `[find_repo] boost-list: remote fetch failed, using bundled disk fallback ` +
        `(${disk.entries().length} entries)`,
    );
    return disk;
  }

  console.warn(`[find_repo] boost-list: empty — Tier 3 disabled for this process`);
  return inMemoryBoostList([]);
}

async function fetchBoostListRemote(
  url: string,
  fetcher: typeof fetch,
): Promise<BoostEntry[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) return undefined;
    const parsed = (await res.json()) as { entries?: unknown };
    return parseEntries(parsed);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read + validate the bundled boost-list.json. Public for the test
 * suite + as the offline-dev fallback path; production callers should
 * use {@link loadBoostList} which checks the remote first.
 */
export async function loadBoostListFromDisk(repoRoot: string): Promise<BoostList> {
  const path = join(repoRoot, "skills", "beevibe-discover-repo", "boost-list.json");
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { entries?: unknown };
    const entries = parseEntries(parsed);
    if (!entries || entries.length === 0) {
      console.warn(`[find_repo] boost-list.json at ${path} has no valid entries`);
      return inMemoryBoostList([]);
    }
    return inMemoryBoostList(entries);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`[find_repo] bundled boost-list.json not found at ${path}`);
    } else {
      console.warn(`[find_repo] bundled boost-list.json load failed:`, err);
    }
    return inMemoryBoostList([]);
  }
}

function parseEntries(parsed: { entries?: unknown }): BoostEntry[] | undefined {
  if (!parsed || !Array.isArray(parsed.entries)) return undefined;
  const entries: BoostEntry[] = [];
  for (const e of parsed.entries) {
    if (!e || typeof e !== "object") continue;
    const r = e as Partial<BoostEntry>;
    if (typeof r.repo_url !== "string" || !r.repo_url) continue;
    if (!Array.isArray(r.goal_keywords)) continue;
    const kws = r.goal_keywords.filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    if (kws.length === 0) continue;
    entries.push({
      repo_url: r.repo_url,
      goal_keywords: kws,
      language: typeof r.language === "string" ? r.language : "unknown",
      category: typeof r.category === "string" ? r.category : "uncategorized",
    });
  }
  return entries;
}
