/**
 * Curated boost list for the find_repo ranker.
 *
 * Loaded once at server startup from
 * `skills/beevibe-discover-repo/boost-list.json` so the same source of
 * truth backs both the (trim) discovery skill and the deterministic
 * ranker. Tests pass an in-memory array directly to bypass disk I/O.
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

export function inMemoryBoostList(entries: readonly BoostEntry[]): BoostList {
  return { entries: () => entries };
}

/**
 * Read + validate the canonical boost-list.json. Returns an empty list
 * (with a warning) if the file is missing or malformed — the ranker
 * degrades gracefully to the other three tiers.
 */
export async function loadBoostListFromDisk(repoRoot: string): Promise<BoostList> {
  const path = join(repoRoot, "skills", "beevibe-discover-repo", "boost-list.json");
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!parsed || !Array.isArray(parsed.entries)) {
      console.warn(`[find_repo] boost-list.json at ${path} has no entries array`);
      return inMemoryBoostList([]);
    }
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
    return inMemoryBoostList(entries);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`[find_repo] boost-list.json not found at ${path}; ranker will skip Tier 3`);
    } else {
      console.warn(`[find_repo] boost-list.json load failed:`, err);
    }
    return inMemoryBoostList([]);
  }
}
