import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  LearnedSkill,
  LearnedSkillRepository,
} from "@beevibe/core";
import { inMemoryBoostList } from "./boost-list.js";
import {
  createFindRepoTool,
  type CommunityRegistryClient,
  type FindRepoCandidate,
  type TrendingClient,
  type TrendingPeriod,
} from "./find-repo.js";

/**
 * The find_repo tool used to be an 80-line prompt-driven skill. The
 * whole point of moving it to code was so the ranker could be tested
 * deterministically. These tests pin tier precedence, fallback
 * behavior, and graceful failure across signal sources.
 */

const AGENT_ID = "agent_caller";
const OWNER_ID = "person_owner";

function fakeAgentRepo(): AgentRepository {
  return {
    findById: vi.fn(async (id: string) =>
      id === AGENT_ID
        ? ({ id: AGENT_ID, owner_id: OWNER_ID, hierarchy_level: "ic" } as Agent)
        : undefined,
    ),
  } as unknown as AgentRepository;
}

function fakeLearnedSkillRepo(
  results: LearnedSkill[] = [],
  opts: { throws?: boolean } = {},
): LearnedSkillRepository {
  return {
    searchByGoal: vi.fn(async () => {
      if (opts.throws) throw new Error("db unavailable");
      return results;
    }),
  } as unknown as LearnedSkillRepository;
}

function makeLearnedSkill(overrides: Partial<LearnedSkill>): LearnedSkill {
  const now = new Date();
  return {
    id: "skill_1",
    name: "extract-pdf-tables",
    goal_pattern: "extract tables from PDFs",
    repo_url: "https://github.com/jsvine/pdfplumber",
    repo_ref: "abc123",
    install_steps: "pip install pdfplumber",
    invocation: "python -m pdfplumber",
    owner_id: OWNER_ID,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const PDFPLUMBER = "https://github.com/jsvine/pdfplumber";
const CAMELOT = "https://github.com/camelot-dev/camelot";
const RANDOM = "https://github.com/random/pdf-thing";

const BOOST = inMemoryBoostList([
  {
    repo_url: PDFPLUMBER,
    goal_keywords: ["pdf", "extract", "table", "parse"],
    language: "python",
    category: "data",
  },
  {
    repo_url: "https://github.com/yt-dlp/yt-dlp",
    goal_keywords: ["youtube", "video", "download"],
    language: "python",
    category: "media",
  },
]);

/**
 * Mock fetcher that returns a static GitHub search response. By
 * default returns nothing (Tier 4 disabled) — individual tests pass
 * their own mock when they want GitHub results.
 */
function emptyFetcher(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ items: [] }),
  })) as unknown as typeof fetch;
}

function githubFetcher(items: Array<{
  html_url: string;
  description?: string | null;
  stargazers_count?: number;
  language?: string | null;
}>): typeof fetch {
  return vi.fn(async (url: unknown) => {
    if (typeof url === "string" && url.includes("api.github.com/search/repositories")) {
      return {
        ok: true,
        json: async () => ({ items }),
      };
    }
    return { ok: false, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

function emptyCommunityRegistry(): CommunityRegistryClient {
  return { fetch: vi.fn(async () => undefined) };
}

function emptyTrending(): TrendingClient {
  return { urlSet: vi.fn(async () => new Set<string>()) };
}

/**
 * Build a trending client whose urlSet returns the given URLs for the
 * specified period (default: daily). Mirrors how the real
 * HttpTrendingClient normalizes URLs — pass raw GitHub URLs and the
 * fake normalizes them with the same lowercase + strip-www rules the
 * production code uses (which is just lowercase + strip `https://www.`,
 * `.git`, trailing slashes).
 */
function trendingWith(
  urls: string[],
  period: TrendingPeriod = "daily",
): TrendingClient {
  const normalized = new Set<string>(urls.map(normalizeForTest));
  return {
    urlSet: vi.fn(async (p: TrendingPeriod) =>
      p === period ? new Set<string>(normalized) : new Set<string>(),
    ),
  };
}

function normalizeForTest(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

function trendingThrows(): TrendingClient {
  return {
    urlSet: vi.fn(async () => {
      throw new Error("trending fetch failed");
    }),
  };
}

describe("find_repo tool", () => {
  it("rejects empty goal", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it("rejects unknown agentId", async () => {
    const tool = createFindRepoTool(
      { agentId: "agent_does_not_exist" },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
  });

  it("boost-list keyword overlap surfaces curated repos with score 20+", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.repo_url).toBe(PDFPLUMBER);
    expect(candidates[0]!.source).toBe("boost");
    // 3 keyword overlap (pdf, extract, table) → 20 + 2*5 = 30
    expect(candidates[0]!.score).toBeGreaterThanOrEqual(20);
    expect(candidates[0]!.score).toBeLessThanOrEqual(35);
    expect(candidates[0]!.matched_keywords).toEqual(
      expect.arrayContaining(["pdf", "extract", "table"]),
    );
  });

  it("learned-skill match outranks a boost-list match for the same goal", async () => {
    const learned = makeLearnedSkill({
      repo_url: CAMELOT,
      name: "extract-tables-camelot",
      goal_pattern: "pull tables out of a pdf",
    });
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo([learned]),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]!.repo_url).toBe(CAMELOT);
    expect(candidates[0]!.source).toBe("learned");
    expect(candidates[0]!.score).toBe(50);
    expect(candidates[0]!.learned_skill?.name).toBe("extract-tables-camelot");
    // pdfplumber from boost list is still present, just ranked below.
    expect(candidates[1]!.repo_url).toBe(PDFPLUMBER);
  });

  it("when learned + boost name the same repo, scores stack and sources merge", async () => {
    const learned = makeLearnedSkill({ repo_url: PDFPLUMBER });
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo([learned]),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    const top = candidates[0]!;
    expect(top.repo_url).toBe(PDFPLUMBER);
    expect(top.score).toBeGreaterThanOrEqual(70); // 50 learned + 20+ boost
    expect(top.sources).toEqual(expect.arrayContaining(["learned", "boost"]));
    expect(top.source).toBe("learned"); // primary precedence
  });

  it("community registry match adds +30 and overlaps with boost", async () => {
    const registry: CommunityRegistryClient = {
      fetch: vi.fn(async () => ({
        skills: [
          {
            repo_url: PDFPLUMBER,
            goal_pattern: "extract tables from pdf documents",
          },
        ],
      })),
    };
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: registry,
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sources).toEqual(
      expect.arrayContaining(["community", "boost"]),
    );
    // 30 community + 20+ boost = 50+
    expect(candidates[0]!.score).toBeGreaterThanOrEqual(50);
    expect(candidates[0]!.source).toBe("community"); // beats boost on precedence
  });

  it("when no curated source matches, falls back to raw GitHub results", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: inMemoryBoostList([]),
        fetcher: githubFetcher([
          {
            html_url: RANDOM,
            description: "a random pdf thing",
            stargazers_count: 1000,
            language: "python",
          },
        ]),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.repo_url).toBe(RANDOM);
    expect(candidates[0]!.source).toBe("github");
    expect(candidates[0]!.stars).toBe(1000);
    // log10(1001)*3 ≈ 9
    expect(candidates[0]!.score).toBeGreaterThan(5);
    expect(candidates[0]!.score).toBeLessThan(15);
  });

  it("GitHub search failure is reported in notes but doesn't fail the call", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: BOOST,
        fetcher: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const body = result.content as { candidates: FindRepoCandidate[]; notes: string[] };
    expect(body.candidates).toHaveLength(1); // boost match survives
    expect(body.notes.some((n) => n.includes("GitHub"))).toBe(true);
  });

  it("learned-skill repo failure is reported in notes but doesn't fail the call", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo([], { throws: true }),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const body = result.content as { candidates: FindRepoCandidate[]; notes: string[] };
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.notes.some((n) => n.includes("learned skill"))).toBe(true);
  });

  it("github search enriches existing boost candidate without double-counting", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: BOOST,
        fetcher: githubFetcher([
          {
            html_url: PDFPLUMBER,
            description: "Plumb a PDF for detailed information",
            stargazers_count: 7300,
            language: "Python",
          },
        ]),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    const top = candidates[0]!;
    expect(top.stars).toBe(7300);
    expect(top.description).toBe("Plumb a PDF for detailed information");
    // Boost score (20–35 range) — GitHub enrich must NOT add popularity
    // points because the repo was already in the candidate set.
    expect(top.score).toBeLessThan(40);
    expect(top.sources).toEqual(expect.arrayContaining(["boost", "github"]));
    expect(top.source).toBe("boost");
  });

  it("respects the limit param (capped between 1 and 10)", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: inMemoryBoostList([]),
        fetcher: githubFetcher(
          Array.from({ length: 15 }, (_, i) => ({
            html_url: `https://github.com/owner/repo-${i}`,
            description: `repo number ${i}`,
            stargazers_count: 1000 - i,
            language: "python",
          })),
        ),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "do something with python", limit: 3 });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(3);
  });

  it("returns helpful hint when no candidates match", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: inMemoryBoostList([]),
        fetcher: githubFetcher([]),
        communityRegistry: emptyCommunityRegistry(),
        trending: emptyTrending(),
      },
    );
    const result = await tool.handler({ goal: "do something obscure xyzzy" });
    const body = result.content as { candidates: FindRepoCandidate[]; hint: string };
    expect(body.candidates).toHaveLength(0);
    expect(body.hint).toContain("No candidates");
  });

  /* ─── Tier 5: GitHub trending ─────────────────────────────────── */

  it("trending tier adds +15 when a GitHub-search candidate is in the daily snapshot", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: inMemoryBoostList([]),
        fetcher: githubFetcher([
          {
            html_url: RANDOM,
            description: "a random pdf thing",
            stargazers_count: 1000,
            language: "python",
          },
        ]),
        communityRegistry: emptyCommunityRegistry(),
        trending: trendingWith([RANDOM], "daily"),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.sources).toEqual(expect.arrayContaining(["github", "trending"]));
    expect(c.source).toBe("trending"); // trending > github in precedence
    // popularityScore(1000) ≈ 9 + trending +15 = ~24
    expect(c.score).toBeGreaterThan(20);
    expect(c.score).toBeLessThan(30);
    expect(c.reason).toContain("trending");
  });

  it("trending in weekly counts too (not just daily)", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: inMemoryBoostList([]),
        fetcher: githubFetcher([
          { html_url: RANDOM, description: "x", stargazers_count: 500, language: "python" },
        ]),
        communityRegistry: emptyCommunityRegistry(),
        trending: trendingWith([RANDOM], "weekly"),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates[0]!.sources).toContain("trending");
  });

  it("trending in monthly is NOT counted (only daily + weekly contribute)", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: inMemoryBoostList([]),
        fetcher: githubFetcher([
          { html_url: RANDOM, description: "x", stargazers_count: 500, language: "python" },
        ]),
        communityRegistry: emptyCommunityRegistry(),
        trending: trendingWith([RANDOM], "monthly"),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates[0]!.sources).not.toContain("trending");
  });

  it("trending lookup failure is reported in notes but doesn't fail the call", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: emptyCommunityRegistry(),
        trending: trendingThrows(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const body = result.content as { candidates: FindRepoCandidate[]; notes: string[] };
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.notes.some((n) => n.includes("trending"))).toBe(true);
  });

  it("boost + trending stack their scores (sources concatenate, score additive)", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        boostList: BOOST,
        fetcher: emptyFetcher(),
        communityRegistry: emptyCommunityRegistry(),
        trending: trendingWith([PDFPLUMBER], "daily"),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    const top = candidates[0]!;
    expect(top.sources).toEqual(expect.arrayContaining(["boost", "trending"]));
    expect(top.source).toBe("boost"); // precedence: boost > trending
    // boost (~30 from 3 keyword overlap) + trending (+15) = ~45
    expect(top.score).toBeGreaterThanOrEqual(35);
    expect(top.score).toBeLessThanOrEqual(50);
  });

  it("learned > community > boost > trending > github precedence holds when all five sources match", async () => {
    const learned = makeLearnedSkill({ repo_url: PDFPLUMBER });
    const registry: CommunityRegistryClient = {
      fetch: vi.fn(async () => ({
        skills: [{ repo_url: PDFPLUMBER, goal_pattern: "extract tables from pdfs" }],
      })),
    };
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo([learned]),
        boostList: BOOST,
        fetcher: githubFetcher([
          { html_url: PDFPLUMBER, description: "Plumb a PDF", stargazers_count: 7000, language: "Python" },
        ]),
        communityRegistry: registry,
        trending: trendingWith([PDFPLUMBER], "daily"),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    const top = candidates[0]!;
    // Every tier contributed
    expect(top.sources).toEqual(
      expect.arrayContaining(["learned", "community", "boost", "trending", "github"]),
    );
    // Primary source = highest precedence
    expect(top.source).toBe("learned");
    // 50 + 30 + ~30(boost) + 15 = ~125 minimum
    expect(top.score).toBeGreaterThanOrEqual(100);
  });
});
