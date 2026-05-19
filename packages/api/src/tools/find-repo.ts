/**
 * find_repo MCP tool — code-first replacement for the prompt-driven
 * ranker that used to live in the beevibe-discover-repo skill.
 *
 * The skill prompt had agents fetch a community registry, hit the
 * GitHub search API, score keyword overlap, and merge multiple tiers
 * inside a single context window. Asking an LLM to follow a
 * deterministic algorithm reliably fights its probabilistic nature;
 * this tool moves the algorithm to code and keeps the LLM for the
 * qualitative final pick.
 *
 * Tool surface:
 *   find_repo({ goal, limit? })  →  { candidates, notes }
 *
 * Ranking tiers (additive scores; multiple sources stack):
 *   +50  learned_skill match (this team's own proven recipe)
 *   +30  community registry match (proven by other Beevibe instances —
 *        promoted from skill_outcome, not hand-curated opinion)
 *   +25  GitHub trending — appears in daily or weekly snapshot
 *        (read from beevibe-ai/beevibe-capabilities, refreshed daily)
 *   +0   GitHub search hit, plus log10(stars+1)·3 popularity bonus
 *
 * What used to be a "+20 curated boost-list" tier was removed —
 * pdfplumber, yt-dlp, FFmpeg etc. are already in every LLM's training
 * data and didn't need a boost. Curation now comes from real outcomes
 * (registry) and real velocity (trending), not opinion drift.
 *
 * The agent reads the top N candidates and picks based on
 * README/description fit. The ranker handles the volume; the agent
 * handles the judgement.
 */
import type {
  AgentRepository,
  LearnedSkill,
  LearnedSkillRepository,
} from "@beevibe/core";
import type { AgentTool, AgentToolResult } from "./types.js";

/**
 * Data layer URLs — all live in the public `beevibe-ai/beevibe-capabilities`
 * repo at `data/`. Served via raw.githubusercontent.com; no auth, no
 * hosting cost, no rate limit. Per-source TTL caches inside this module
 * mean a /mcp roundtrip pays at most three HTTP requests per process
 * lifetime (one per file per hour).
 */
const CAPABILITIES_BASE_URL =
  process.env.BEEVIBE_CAPABILITIES_BASE_URL ??
  "https://raw.githubusercontent.com/beevibe-ai/beevibe-capabilities/main/data";

const COMMUNITY_REGISTRY_URL =
  process.env.BEEVIBE_COMMUNITY_REGISTRY_URL ??
  `${CAPABILITIES_BASE_URL}/registry.json`;
const COMMUNITY_REGISTRY_TTL_MS = 60 * 60 * 1000;

const TRENDING_TTL_MS = 60 * 60 * 1000;

/** GitHub stop-words we strip from the query (and from match overlap). */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "of", "to", "in", "on", "at",
  "for", "with", "by", "from", "as", "this", "that", "it", "be", "are",
  "was", "were", "i", "we", "you", "they", "my", "our", "your", "their",
  "do", "does", "did", "have", "has", "had", "into", "out", "up", "down",
  "use", "using", "used", "make", "want", "need", "please", "can",
]);

const FIND_REPO_SCHEMA = {
  type: "object",
  properties: {
    goal: {
      type: "string",
      description:
        "What you need done, in plain language. Examples: 'extract " +
        "tables from a PDF', 'download audio from a YouTube video', " +
        "'take a screenshot of a webpage'. Be concrete enough to yield " +
        "meaningful search terms.",
    },
    limit: {
      type: "number",
      description: "Max candidates to return (default 5, capped at 10).",
    },
  },
  required: ["goal"],
  additionalProperties: false,
} as const;

export type CandidateSource = "learned" | "community" | "trending" | "github";

export interface FindRepoCandidate {
  repo_url: string;
  score: number;
  /** Highest-precedence source (learned > community > trending > github). */
  source: CandidateSource;
  /** Every source that contributed to the score. Useful for debugging. */
  sources: CandidateSource[];
  /** Human-readable explanation of why this candidate scored. */
  reason: string;
  /** GitHub stars when available (best-effort enrich). */
  stars?: number;
  /** GitHub description when available. */
  description?: string;
  /** Programming language inferred from GitHub. */
  language?: string;
  /** Hydrated learned_skill row when source includes "learned". */
  learned_skill?: {
    id: string;
    name: string;
    goal_pattern: string;
    invocation: string;
  };
}

export interface FindRepoContext {
  agentId: string;
}

export interface FindRepoServices {
  agentRepo: AgentRepository;
  learnedSkillRepo: LearnedSkillRepository;
  /** Override for tests; defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Override for tests; defaults to a module-level cache. */
  communityRegistry?: CommunityRegistryClient;
  /** Override for tests; defaults to an HTTP client against the public capabilities repo. */
  trending?: TrendingClient;
  /** Optional GitHub PAT; raises rate limit from 60/h to 5000/h. */
  githubToken?: string;
}

interface CommunityRegistryEntry {
  repo_url: string;
  goal_pattern: string;
  invocation?: string;
}

interface CommunityRegistry {
  skills: CommunityRegistryEntry[];
}

export interface CommunityRegistryClient {
  fetch(): Promise<CommunityRegistry | undefined>;
}

class HttpCommunityRegistryClient implements CommunityRegistryClient {
  private cached?: { at: number; data: CommunityRegistry };
  constructor(private readonly fetcher: typeof fetch) {}

  async fetch(): Promise<CommunityRegistry | undefined> {
    if (this.cached && Date.now() - this.cached.at < COMMUNITY_REGISTRY_TTL_MS) {
      return this.cached.data;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await this.fetcher(COMMUNITY_REGISTRY_URL, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return undefined;
      const data = (await res.json()) as CommunityRegistry;
      if (!data || !Array.isArray(data.skills)) return undefined;
      this.cached = { at: Date.now(), data };
      return data;
    } catch {
      return undefined;
    }
  }
}

/* ─── Trending client (Tier 5) ───────────────────────────────────── */

export type TrendingPeriod = "daily" | "weekly" | "monthly";

interface TrendingRepoEntry {
  repo_url: string;
}
interface TrendingSnapshot {
  period: TrendingPeriod;
  repos: TrendingRepoEntry[];
}

/**
 * Read-side client for the GitHub trending snapshots in
 * beevibe-ai/beevibe-capabilities. The ranker calls `urlSet(period)`
 * once per find_repo invocation per period so candidate checks are
 * O(1) Set lookups, not per-candidate HTTP requests.
 *
 * Default impl is HTTP; tests inject a fake (`{ urlSet: vi.fn(...) }`)
 * to bypass the network.
 */
export interface TrendingClient {
  urlSet(period: TrendingPeriod): Promise<Set<string>>;
}

class HttpTrendingClient implements TrendingClient {
  private cached = new Map<TrendingPeriod, { at: number; urls: Set<string> }>();
  constructor(private readonly fetcher: typeof fetch) {}

  async urlSet(period: TrendingPeriod): Promise<Set<string>> {
    const hit = this.cached.get(period);
    if (hit && Date.now() - hit.at < TRENDING_TTL_MS) return hit.urls;

    const url = `${CAPABILITIES_BASE_URL}/trending-${period}.json`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await this.fetcher(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        // Cache the miss so we don't hammer raw.githubusercontent during
        // a long outage. TTL on the empty set is the same — re-check
        // after the next hour.
        const empty = new Set<string>();
        this.cached.set(period, { at: Date.now(), urls: empty });
        return empty;
      }
      const data = (await res.json()) as TrendingSnapshot;
      const urls = new Set<string>(
        Array.isArray(data.repos)
          ? data.repos.map((r) => normalizeUrl(r.repo_url))
          : [],
      );
      this.cached.set(period, { at: Date.now(), urls });
      return urls;
    } catch {
      const empty = new Set<string>();
      this.cached.set(period, { at: Date.now(), urls: empty });
      return empty;
    }
  }
}

/* ─── Tool factory ───────────────────────────────────────────────── */

export function createFindRepoTool(
  ctx: FindRepoContext,
  services: FindRepoServices,
): AgentTool {
  const fetcher = services.fetcher ?? globalThis.fetch.bind(globalThis);
  const registry =
    services.communityRegistry ?? new HttpCommunityRegistryClient(fetcher);
  const trending = services.trending ?? new HttpTrendingClient(fetcher);
  const githubToken = services.githubToken ?? process.env.GITHUB_TOKEN;

  return {
    name: "find_repo",
    description:
      "Rank GitHub repos for a goal. Returns the top N candidates from " +
      "four signal sources (your team's learned skills, the community " +
      "registry of proven outcomes, GitHub trending this week, and " +
      "live GitHub search).\n\n" +
      "**Call this when you need a tool you don't have, before deciding " +
      "to report a blocker or shell out to `brew install`.** It's cheap " +
      "(no sandbox boots, no LLM calls — just data lookups + a single " +
      "GitHub API request) and the ranking is deterministic, so you " +
      "only need to pick the candidate whose description matches your " +
      "goal. Pair with `use_repo` to actually run the chosen repo in a " +
      "sandbox.",
    schema: FIND_REPO_SCHEMA as Record<string, unknown>,
    handler: async (input) =>
      findRepoHandler(input, ctx, services, fetcher, registry, trending, githubToken),
  };
}

async function findRepoHandler(
  input: Record<string, unknown>,
  ctx: FindRepoContext,
  services: FindRepoServices,
  fetcher: typeof fetch,
  registry: CommunityRegistryClient,
  trending: TrendingClient,
  githubToken: string | undefined,
): Promise<AgentToolResult> {
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) {
    return {
      content: { error: "invalid_goal", message: "goal must be a non-empty string" },
      isError: true,
    };
  }
  const limitRaw = typeof input.limit === "number" ? input.limit : 5;
  const limit = Math.min(10, Math.max(1, Math.floor(limitRaw)));

  // Resolve the agent's owner so we can scope learned-skill lookups.
  const agent = await services.agentRepo.findById(ctx.agentId);
  if (!agent) {
    return {
      content: { error: "agent_not_found", message: "calling agent not found" },
      isError: true,
    };
  }

  const goalKeywords = extractKeywords(goal);
  const notes: string[] = [];
  const candidates = new Map<string, FindRepoCandidate>();

  // ── Tier 2: Local learned skills (highest priority signal) ────────
  try {
    const skills = await services.learnedSkillRepo.searchByGoal(
      agent.owner_id,
      goal,
      { limit: 10 },
    );
    for (const skill of skills) {
      const c = ensureCandidate(candidates, skill.repo_url);
      c.score += 50;
      c.sources.push("learned");
      c.learned_skill = {
        id: skill.id,
        name: skill.name,
        goal_pattern: skill.goal_pattern,
        invocation: skill.invocation,
      };
    }
  } catch (err) {
    notes.push(`learned skill lookup failed: ${errMsg(err)}`);
  }

  // ── Tier 1: Community registry (best-effort, may 404) ─────────────
  try {
    const reg = await registry.fetch();
    if (reg) {
      for (const entry of reg.skills) {
        const overlap = countOverlap(goalKeywords, splitWords(entry.goal_pattern));
        if (overlap >= 2) {
          const c = ensureCandidate(candidates, entry.repo_url);
          c.score += 30;
          c.sources.push("community");
        }
      }
    } else {
      notes.push("community registry unavailable (proceeding without Tier 1)");
    }
  } catch (err) {
    notes.push(`community registry error: ${errMsg(err)}`);
  }

  // ── Tier 4: GitHub search (best-effort, popularity scoring) ───────
  try {
    const githubResults = await searchGitHub(goalKeywords, fetcher, githubToken);
    for (const repo of githubResults.slice(0, 20)) {
      const url = repo.html_url;
      // Drop self-described propaganda repos — keyword overlap with
      // legitimate tools is incidental; they aren't tools.
      if (isFilteredOutContent(repo.description)) continue;
      const existing = candidates.get(normalizeUrl(url));
      if (existing) {
        // Enrich existing candidate with GitHub metadata.
        existing.sources.push("github");
        existing.stars ??= repo.stargazers_count;
        existing.description ??= repo.description ?? undefined;
        existing.language ??= repo.language ?? undefined;
      } else {
        // Raw GitHub-only candidate.
        const c = ensureCandidate(candidates, url);
        c.score += popularityScore(repo.stargazers_count);
        c.sources.push("github");
        c.stars = repo.stargazers_count;
        c.description = repo.description ?? undefined;
        c.language = repo.language ?? undefined;
      }
    }
  } catch (err) {
    notes.push(`GitHub search failed: ${errMsg(err)}`);
  }

  // ── Tier 5: GitHub trending (snapshot lookup, no per-candidate I/O) ─
  // Fetch the daily + weekly url sets once per call (TTL'd in the
  // client), then check every existing candidate in O(1). Trending +25
  // is the primary "this is the moment" signal now that the boost-list
  // tier is gone. Sits below community (+30) which is for repos
  // already proven across beevibe instances, but above raw GitHub
  // popularity so a hot new repo can outrank a generic high-star match.
  try {
    const [daily, weekly] = await Promise.all([
      trending.urlSet("daily"),
      trending.urlSet("weekly"),
    ]);
    for (const c of candidates.values()) {
      const key = normalizeUrl(c.repo_url);
      if (daily.has(key) || weekly.has(key)) {
        c.score += 25;
        c.sources.push("trending");
      }
    }
  } catch (err) {
    notes.push(`trending lookup failed: ${errMsg(err)}`);
  }

  // Finalize each candidate: primary source + human reason string.
  for (const c of candidates.values()) {
    c.source = pickPrimarySource(c.sources);
    c.reason = formatReason(c);
  }

  const ranked = Array.from(candidates.values())
    .sort((a, b) => b.score - a.score || (b.stars ?? 0) - (a.stars ?? 0))
    .slice(0, limit);

  return {
    content: {
      goal,
      candidates: ranked,
      notes,
      hint:
        ranked.length > 0
          ? "Pick the candidate whose description best matches your goal, then call use_repo with that repo_url."
          : "No candidates found. Try rephrasing the goal with more concrete nouns/verbs, or call use_repo directly with a repo you already know.",
    },
  };
}

/* ─── helpers ────────────────────────────────────────────────────── */

function ensureCandidate(
  map: Map<string, FindRepoCandidate>,
  repoUrl: string,
): FindRepoCandidate {
  const key = normalizeUrl(repoUrl);
  let c = map.get(key);
  if (!c) {
    c = {
      repo_url: repoUrl,
      score: 0,
      source: "github",
      sources: [],
      reason: "",
    };
    map.set(key, c);
  }
  return c;
}

function normalizeUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

function extractKeywords(goal: string): string[] {
  return splitWords(goal).filter((w) => !STOP_WORDS.has(w));
}

function splitWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
}

/**
 * Tiny stemmer: strip common plural-ish suffixes so "tables" ≈ "table",
 * "queries" ≈ "query", "boxes" ≈ "box". Heuristic-only — good enough
 * for boost-list keyword overlap, not a real NLP stemmer. Only strips
 * `-es` after a sibilant cluster so `tables` doesn't collapse to `tabl`.
 */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(w) && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  return w;
}

function countOverlap(a: string[], b: string[]): number {
  const setB = new Set(b.map(stem));
  let n = 0;
  for (const w of a) if (setB.has(stem(w))) n++;
  return n;
}

function popularityScore(stars: number): number {
  if (!Number.isFinite(stars) || stars <= 0) return 0;
  return Math.min(15, Math.log10(stars + 1) * 3);
}

/**
 * Description-level content filter for the GitHub-search tier. Single
 * neutral word — keyword overlap on this term reliably picks up repos
 * that self-describe as such, which by definition aren't tools.
 */
const FILTERED_DESCRIPTION_PATTERN = /\bpropaganda\b/i;

function isFilteredOutContent(description: string | null | undefined): boolean {
  if (!description) return false;
  return FILTERED_DESCRIPTION_PATTERN.test(description);
}

function pickPrimarySource(sources: CandidateSource[]): CandidateSource {
  // Trust order: this team's own proven recipes beat community-proven,
  // which beats current trending velocity, which beats raw GitHub
  // popularity. Trending is the primary surfacing signal for novel
  // capabilities — exactly the gap a static curated list would miss.
  if (sources.includes("learned")) return "learned";
  if (sources.includes("community")) return "community";
  if (sources.includes("trending")) return "trending";
  return "github";
}

function formatReason(c: FindRepoCandidate): string {
  const parts: string[] = [];
  if (c.sources.includes("learned") && c.learned_skill) {
    parts.push(`learned skill "${c.learned_skill.name}" already proven for this kind of goal`);
  }
  if (c.sources.includes("community")) {
    parts.push("registered in the community registry");
  }
  if (c.sources.includes("trending")) {
    parts.push("trending on GitHub this week");
  }
  if (c.sources.includes("github") && typeof c.stars === "number") {
    parts.push(`${c.stars.toLocaleString()} stars on GitHub`);
  }
  return parts.join("; ") || "no signal";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ─── GitHub search ──────────────────────────────────────────────── */

interface GitHubRepo {
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
}

async function searchGitHub(
  keywords: string[],
  fetcher: typeof fetch,
  token: string | undefined,
): Promise<GitHubRepo[]> {
  if (keywords.length === 0) return [];
  const q = keywords.slice(0, 6).join("+");
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=20`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `token ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetcher(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`GitHub search ${res.status}`);
    }
    const body = (await res.json()) as { items?: GitHubRepo[] };
    return Array.isArray(body.items) ? body.items : [];
  } finally {
    clearTimeout(timer);
  }
}
