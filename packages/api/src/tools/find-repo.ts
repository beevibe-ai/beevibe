/**
 * find_repo MCP tool — agentic-search ranker for GitHub repos.
 *
 * The relevance gate used to be regex keyword-overlap, which is
 * brittle: "find me some geo or seo repos" yielded weak tokens like
 * `find` and `me`, which then matched any trending description that
 * happened to contain those words. Result: noisy candidates the agent
 * had to filter in prose.
 *
 * The fix moves relevance to vector embeddings. The goal is embedded
 * once; community-registry entries and trending-repo entries are
 * embedded too (precomputed when available, on-demand otherwise),
 * cached for the snapshot TTL. Cosine similarity replaces keyword
 * overlap everywhere it was used.
 *
 * Tool surface:
 *   find_repo({ goal, limit? })  →  { candidates, notes }
 *
 * Ranking tiers (additive scores; multiple sources stack):
 *   +50  learned_skill match (this team's own proven recipe — Postgres
 *        full-text on goal_pattern handles relevance here)
 *   +35  GitHub trending — appears in daily or weekly snapshot AND has
 *        cosine similarity to goal ≥ SIM_THRESHOLD
 *   +30  community registry match (cosine similarity ≥ SIM_THRESHOLD)
 *   +0   GitHub search hit (raw goal as query), plus
 *        log10(stars+1)·3 popularity bonus
 *
 * Why trending sits above community: users explicitly want "trendy
 * ones" surfaced first. The community registry has long-tail proof
 * but tends toward stable, slow-moving repos; trending captures what
 * the world is paying attention to right now.
 *
 * The agent reads the top N candidates and picks based on
 * README/description fit. The ranker handles the volume; the agent
 * handles the judgement.
 */
import type {
  AgentRepository,
  EmbeddingService,
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

/**
 * Cosine-similarity floor for "this entry is semantically relevant to
 * the goal." Empirically:
 *   ≥ 0.6  near-duplicate phrasing
 *   ≥ 0.4  same topic, different wording
 *   ≥ 0.3  loosely related (still useful for trending injection)
 *   < 0.3  not really related
 *
 * 0.35 lets a trending repo with description "GEO-first SEO skill for
 * Claude Code" surface for "find me some geo or seo repos" while
 * keeping a Linux-kernel trending repo out of the result.
 */
const SIM_THRESHOLD = 0.35;

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
  /**
   * Embedding service used to compute the goal vector and (on demand)
   * embed community-registry + trending entries that didn't ship with
   * precomputed vectors. Same instance the memory layer uses.
   */
  embeddings: EmbeddingService;
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
  /** Precomputed embedding of `goal_pattern`. Optional — find_repo
   *  computes it on demand when missing. */
  embedding?: number[];
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

export interface TrendingRepoEntry {
  repo_url: string;
  owner?: string;
  name?: string;
  description?: string | null;
  language?: string | null;
  /** Stars gained in the period (velocity, NOT lifetime). */
  stars_gained?: number;
  /** Precomputed embedding of `owner/name + description`. When present,
   *  find_repo skips the runtime embed call. fetch-trending.ts writes
   *  these into the JSON; old snapshots without the field still work. */
  embedding?: number[];
}

interface TrendingSnapshot {
  period: TrendingPeriod;
  repos: TrendingRepoEntry[];
}

/**
 * Read-side client for the GitHub trending snapshots in
 * beevibe-ai/beevibe-capabilities. Returns both the O(1) URL set (used
 * to bump existing candidates) and the rich entries (used to INJECT
 * fresh candidates when the github-search tier missed a hot repo —
 * e.g. a repo with strong velocity but a name that doesn't match the
 * user's exact keywords).
 *
 * Default impl is HTTP; tests inject a fake (`{ snapshot: vi.fn(...) }`)
 * to bypass the network.
 */
export interface TrendingClient {
  snapshot(period: TrendingPeriod): Promise<{
    urls: Set<string>;
    entries: TrendingRepoEntry[];
  }>;
}

class HttpTrendingClient implements TrendingClient {
  private cached = new Map<
    TrendingPeriod,
    { at: number; urls: Set<string>; entries: TrendingRepoEntry[] }
  >();
  constructor(private readonly fetcher: typeof fetch) {}

  async snapshot(period: TrendingPeriod): Promise<{
    urls: Set<string>;
    entries: TrendingRepoEntry[];
  }> {
    const hit = this.cached.get(period);
    if (hit && Date.now() - hit.at < TRENDING_TTL_MS) {
      return { urls: hit.urls, entries: hit.entries };
    }

    const url = `${CAPABILITIES_BASE_URL}/trending-${period}.json`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await this.fetcher(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        // Cache the miss so we don't hammer raw.githubusercontent during
        // a long outage. TTL on the empty cache is the same — re-check
        // after the next hour.
        const empty = { urls: new Set<string>(), entries: [] as TrendingRepoEntry[] };
        this.cached.set(period, { at: Date.now(), ...empty });
        return empty;
      }
      const data = (await res.json()) as TrendingSnapshot;
      const entries = Array.isArray(data.repos) ? data.repos : [];
      const urls = new Set<string>(entries.map((r) => normalizeUrl(r.repo_url)));
      this.cached.set(period, { at: Date.now(), urls, entries });
      return { urls, entries };
    } catch {
      const empty = { urls: new Set<string>(), entries: [] as TrendingRepoEntry[] };
      this.cached.set(period, { at: Date.now(), ...empty });
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

  const notes: string[] = [];
  const candidates = new Map<string, FindRepoCandidate>();

  // Single embedding call for the goal — everything else compares
  // against this vector. If embeddings are unavailable (e.g. provider
  // outage), drop to GitHub-search-only and emit a note so the agent
  // knows trending/community didn't run.
  let goalVec: number[] | undefined;
  try {
    goalVec = await services.embeddings.embed(goal);
  } catch (err) {
    notes.push(`embedding goal failed (semantic tiers skipped): ${errMsg(err)}`);
  }

  // ── Tier 2: Local learned skills (highest priority signal) ────────
  // Postgres FTS on goal_pattern handles relevance — no embedding
  // call needed. Same behavior as before.
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
  // Cosine similarity of goal vector against each entry's goal_pattern
  // vector. Entries without precomputed embeddings get embedded in a
  // single batch call (cached by module-level Map for the process
  // lifetime; the registry itself is also TTL-cached for an hour).
  if (goalVec) {
    try {
      const reg = await registry.fetch();
      if (reg) {
        const entryVecs = await ensureRegistryEmbeddings(reg.skills, services.embeddings);
        for (const entry of reg.skills) {
          const vec = entryVecs.get(entry.goal_pattern);
          if (!vec) continue;
          const sim = cosineSimilarity(goalVec, vec);
          if (sim < SIM_THRESHOLD) continue;
          const c = ensureCandidate(candidates, entry.repo_url);
          c.score += 30;
          c.sources.push("community");
        }
      } else {
        notes.push("community registry unavailable (proceeding without Tier 1)");
      }
    } catch (err) {
      notes.push(`community registry error: ${errMsg(err)}`);
    }
  }

  // ── Tier 4: GitHub search (best-effort, popularity scoring) ───────
  // GitHub's own search handles the keyword stuff — we pass the raw
  // goal in. GitHub ranks by its blended relevance + popularity and we
  // re-rank by stars locally.
  try {
    const githubResults = await searchGitHub(goal, fetcher, githubToken);
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
  // Two passes, both gated by cosine similarity to the goal vector:
  //   (a) bump existing candidates that appear in daily or weekly
  //       trending by +35.
  //   (b) INJECT trending entries that didn't come up in github-search
  //       AND have similarity ≥ SIM_THRESHOLD. This is how
  //       `zubair-trabzada/geo-seo-claude` surfaces for a "find me geo
  //       or seo repos" query even when github-search's ranking
  //       doesn't return it.
  if (goalVec) {
    try {
      const [daily, weekly] = await Promise.all([
        trending.snapshot("daily"),
        trending.snapshot("weekly"),
      ]);
      const allTrending = [...daily.entries, ...weekly.entries];
      const trendingVecs = await ensureTrendingEmbeddings(
        allTrending,
        services.embeddings,
      );

      // (a) Bump existing candidates.
      for (const c of candidates.values()) {
        const key = normalizeUrl(c.repo_url);
        if (daily.urls.has(key) || weekly.urls.has(key)) {
          c.score += 35;
          c.sources.push("trending");
        }
      }

      // (b) Inject trending entries that semantically match the goal.
      // Dedup across daily + weekly by canonical URL; daily wins so we
      // surface today's hot repos first.
      const seenForInject = new Set<string>();
      for (const entry of allTrending) {
        const key = normalizeUrl(entry.repo_url);
        if (seenForInject.has(key)) continue;
        seenForInject.add(key);
        if (candidates.has(key)) continue; // already counted in pass (a)

        const vec = trendingVecs.get(key);
        if (!vec) continue;
        const sim = cosineSimilarity(goalVec, vec);
        if (sim < SIM_THRESHOLD) continue;

        const c = ensureCandidate(candidates, entry.repo_url);
        // Tiny bonus for higher similarity so a strong match outranks
        // a marginal one. 35 + 0..15 keeps it within trending's band.
        c.score += 35 + Math.round(15 * Math.max(0, Math.min(1, sim)));
        c.sources.push("trending");
        if (entry.description) c.description = entry.description;
        if (entry.language) c.language = entry.language;
      }
    } catch (err) {
      notes.push(`trending lookup failed: ${errMsg(err)}`);
    }
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

/* ─── Embedding helpers ──────────────────────────────────────────── */

/**
 * Cosine similarity in [-1, 1]; we treat values < 0 as "not similar"
 * and only act on scores ≥ SIM_THRESHOLD. NaN-safe — returns 0 for
 * zero-magnitude inputs so a malformed vector never blocks the call.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Module-level embedding cache. Trending + community entries don't
 * change between find_repo calls within the same process; embedding
 * once and re-using across requests saves 99% of API spend.
 *
 * Keys:
 *   trendingEmbeddingCache: canonical-normalized repo_url
 *   communityEmbeddingCache: goal_pattern string (the thing being embedded)
 */
const trendingEmbeddingCache = new Map<string, number[]>();
const communityEmbeddingCache = new Map<string, number[]>();

function trendingHaystack(e: TrendingRepoEntry): string {
  return [e.owner, e.name, e.description ?? ""].filter(Boolean).join(" ");
}

async function ensureTrendingEmbeddings(
  entries: TrendingRepoEntry[],
  embeddings: EmbeddingService,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const toEmbed: { key: string; text: string }[] = [];
  for (const e of entries) {
    const key = normalizeUrl(e.repo_url);
    if (out.has(key)) continue; // dedup across daily/weekly
    if (Array.isArray(e.embedding) && e.embedding.length > 0) {
      out.set(key, e.embedding);
      continue;
    }
    const cached = trendingEmbeddingCache.get(key);
    if (cached) {
      out.set(key, cached);
      continue;
    }
    const text = trendingHaystack(e);
    if (!text) continue;
    toEmbed.push({ key, text });
  }
  if (toEmbed.length === 0) return out;
  const vecs = await embeddings.embedBatch(toEmbed.map((t) => t.text));
  for (let i = 0; i < toEmbed.length; i++) {
    const key = toEmbed[i]!.key;
    const vec = vecs[i];
    if (!vec) continue;
    trendingEmbeddingCache.set(key, vec);
    out.set(key, vec);
  }
  return out;
}

async function ensureRegistryEmbeddings(
  entries: CommunityRegistryEntry[],
  embeddings: EmbeddingService,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const toEmbed: { key: string; text: string }[] = [];
  for (const e of entries) {
    if (out.has(e.goal_pattern)) continue;
    if (Array.isArray(e.embedding) && e.embedding.length > 0) {
      out.set(e.goal_pattern, e.embedding);
      continue;
    }
    const cached = communityEmbeddingCache.get(e.goal_pattern);
    if (cached) {
      out.set(e.goal_pattern, cached);
      continue;
    }
    toEmbed.push({ key: e.goal_pattern, text: e.goal_pattern });
  }
  if (toEmbed.length === 0) return out;
  const vecs = await embeddings.embedBatch(toEmbed.map((t) => t.text));
  for (let i = 0; i < toEmbed.length; i++) {
    const key = toEmbed[i]!.key;
    const vec = vecs[i];
    if (!vec) continue;
    communityEmbeddingCache.set(key, vec);
    out.set(key, vec);
  }
  return out;
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
  // Trust order: learned > trending > community > github. The user's
  // explicit preference is "prefer trendy ones", so trending wins the
  // label when a candidate has both trending velocity and community
  // proof — it's the more time-relevant signal for fresh queries.
  if (sources.includes("learned")) return "learned";
  if (sources.includes("trending")) return "trending";
  if (sources.includes("community")) return "community";
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
  goal: string,
  fetcher: typeof fetch,
  token: string | undefined,
): Promise<GitHubRepo[]> {
  // Pass the raw goal as the query. GitHub's search engine handles
  // stop-words, stemming, and relevance internally — much smarter
  // than a hand-rolled regex pipeline ever was. Sorting by stars
  // keeps the popular hits at the top for the popularity-score blend.
  const q = goal.trim();
  if (!q) return [];
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
