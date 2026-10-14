import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  EmbeddingService,
  LearnedSkill,
  LearnedSkillRepository,
} from "@beevibe/core";
import {
  createFindRepoTool,
  type CommunityRegistryClient,
  type FindRepoCandidate,
  type TrendingClient,
  type TrendingPeriod,
} from "./find-repo.js";

/**
 * Default fake embedding service: every text gets the same vector, so
 * cosine similarity is always 1.0. This lets pre-existing tests stay
 * focused on tier-scoring without worrying about relevance gating.
 *
 * Tests that DO want to exercise relevance gating (e.g. "trending repo
 * with unrelated description must NOT inject") pass a predicate-based
 * fake instead — `fakeEmbeddingsMatching(predicate)`.
 */
function fakeEmbeddingsAllMatch(): EmbeddingService {
  const vec = [1, 0];
  return {
    type: "fake:all-match",
    embed: vi.fn(async () => vec),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => vec)),
  };
}

/**
 * Selective fake: texts matching `predicate` get vector A; everything
 * else gets the orthogonal vector B. Cosine(A,A)=1, cosine(A,B)=0 —
 * predicate-true entries cross SIM_THRESHOLD, predicate-false don't.
 */
function fakeEmbeddingsMatching(predicate: (text: string) => boolean): EmbeddingService {
  const match = [1, 0];
  const noMatch = [0, 1];
  return {
    type: "fake:matching",
    embed: vi.fn(async (text: string) => (predicate(text) ? match : noMatch)),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map((t) => (predicate(t) ? match : noMatch)),
    ),
  };
}

/**
 * The find_repo tool used to be an 80-line prompt-driven skill. The
 * whole point of moving it to code was so the ranker could be tested
 * deterministically.
 *
 * Four tiers (no curated boost list — removed as opinion-drift theater):
 *   learned   +50  this team's own proven recipe
 *   trending  +35  on GitHub trending daily or weekly
 *   community +30  proven across other beevibe instances
 *   github    ~0   raw search + popularity bonus
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
const RANDOM = "https://github.com/random/repo";

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
      return { ok: true, json: async () => ({ items }) };
    }
    return { ok: false, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

function emptyCommunityRegistry(): CommunityRegistryClient {
  return { fetch: vi.fn(async () => undefined) };
}

function emptyTrending(): TrendingClient {
  return { snapshot: vi.fn(async () => ({ urls: new Set<string>(), entries: [] })) };
}

function normalizeForTest(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

function trendingWith(urls: string[], period: TrendingPeriod = "daily"): TrendingClient {
  const normalized = new Set<string>(urls.map(normalizeForTest));
  return {
    snapshot: vi.fn(async (p: TrendingPeriod) =>
      p === period
        ? { urls: new Set<string>(normalized), entries: [] }
        : { urls: new Set<string>(), entries: [] },
    ),
  };
}

/**
 * Trending fake with rich entries — used to test the injection pass
 * (a trending repo that wasn't in github search still surfaces as a
 * candidate when its description shares keywords with the goal).
 */
function trendingWithEntries(
  entries: Array<{ repo_url: string; owner?: string; name?: string; description?: string | null; language?: string | null; stars_gained?: number }>,
  period: TrendingPeriod = "daily",
): TrendingClient {
  const urls = new Set<string>(entries.map((e) => normalizeForTest(e.repo_url)));
  return {
    snapshot: vi.fn(async (p: TrendingPeriod) =>
      p === period ? { urls, entries } : { urls: new Set<string>(), entries: [] },
    ),
  };
}

function trendingThrows(): TrendingClient {
  return {
    snapshot: vi.fn(async () => {
      throw new Error("trending fetch failed");
    }),
  };
}

const BASE_SERVICES = () => ({
  agentRepo: fakeAgentRepo(),
  learnedSkillRepo: fakeLearnedSkillRepo(),
  embeddings: fakeEmbeddingsAllMatch(),
  fetcher: emptyFetcher(),
  communityRegistry: emptyCommunityRegistry(),
  trending: emptyTrending(),
});

describe("find_repo tool — input validation", () => {
  it("rejects empty goal", async () => {
    const tool = createFindRepoTool({ agentId: AGENT_ID }, BASE_SERVICES());
    const result = await tool.handler({ goal: "" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it("rejects unknown agentId", async () => {
    const tool = createFindRepoTool({ agentId: "agent_does_not_exist" }, BASE_SERVICES());
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
  });
});

describe("find_repo tool — tier behavior", () => {
  it("learned skill match scores +50 and becomes the primary source", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        learnedSkillRepo: fakeLearnedSkillRepo([makeLearnedSkill({ repo_url: CAMELOT })]),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.repo_url).toBe(CAMELOT);
    expect(candidates[0]!.source).toBe("learned");
    expect(candidates[0]!.score).toBe(50);
  });

  it("community registry match scores +30 and surfaces as primary when no learned", async () => {
    const registry: CommunityRegistryClient = {
      fetch: vi.fn(async () => ({
        skills: [
          { repo_url: PDFPLUMBER, goal_pattern: "extract tables from pdf documents" },
        ],
      })),
    };
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      { ...BASE_SERVICES(), communityRegistry: registry },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe("community");
    expect(candidates[0]!.score).toBe(30);
  });

  it("trending match scores +35 and surfaces when no curated tier hits", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        fetcher: githubFetcher([
          { html_url: RANDOM, description: "x", stargazers_count: 500, language: "python" },
        ]),
        trending: trendingWith([RANDOM], "daily"),
      },
    );
    const result = await tool.handler({ goal: "do something" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe("trending");
    expect(candidates[0]!.sources).toEqual(expect.arrayContaining(["github", "trending"]));
    // +35 trending + popularityScore(500) ≈ +8 = ~43
    expect(candidates[0]!.score).toBeGreaterThan(40);
    expect(candidates[0]!.score).toBeLessThan(50);
  });

  it("injects trending repos that github search missed when goal is semantically related", async () => {
    // Regression: github search ranks by its own relevance and may skip
    // a 7k-star trending repo whose name/description doesn't match the
    // user's exact query. The trending tier should still surface it as
    // long as the goal embedding lines up with the entry embedding.
    const TRENDING_GEO_SEO = "https://github.com/zubair-trabzada/geo-seo-claude";
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        // Semantic fake: only texts containing "seo" embed to the
        // match vector. So the goal ("find me some SEO tools") and the
        // entry's haystack ("zubair-trabzada geo-seo-claude GEO-first
        // SEO skill...") both match — cosine 1.0.
        embeddings: fakeEmbeddingsMatching((text) => /seo/i.test(text)),
        // GitHub search returns nothing — simulates the case where the
        // hot trending repo didn't make github's top results.
        fetcher: githubFetcher([]),
        trending: trendingWithEntries(
          [
            {
              repo_url: TRENDING_GEO_SEO,
              owner: "zubair-trabzada",
              name: "geo-seo-claude",
              description: "GEO-first SEO skill for Claude Code. AI search optimization.",
              language: "Python",
              stars_gained: 7400,
            },
          ],
          "daily",
        ),
      },
    );
    const result = await tool.handler({ goal: "find me some SEO tools" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.repo_url).toBe(TRENDING_GEO_SEO);
    expect(candidates[0]!.source).toBe("trending");
    expect(candidates[0]!.description).toContain("GEO-first SEO");
    expect(candidates[0]!.language).toBe("Python");
  });

  it("does NOT inject trending repos with no semantic relation to the goal", async () => {
    // The injection pass must keep a relevance filter or trending
    // dumps unrelated repos into every find_repo response.
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        // Selective fake: only "seo"-containing texts match. The
        // "Linux kernel hacks" trending entry below embeds to the
        // orthogonal vector → cosine 0 → below SIM_THRESHOLD → skip.
        embeddings: fakeEmbeddingsMatching((text) => /seo/i.test(text)),
        fetcher: githubFetcher([]),
        trending: trendingWithEntries(
          [
            {
              repo_url: "https://github.com/totally/unrelated",
              owner: "totally",
              name: "unrelated",
              description: "Linux kernel hacks for embedded devices.",
              language: "C",
            },
          ],
          "daily",
        ),
      },
    );
    const result = await tool.handler({ goal: "find me some SEO tools" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(0);
  });

  it("trending in weekly counts, monthly does NOT", async () => {
    const inDaily = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        fetcher: githubFetcher([
          { html_url: RANDOM, description: "x", stargazers_count: 500, language: "python" },
        ]),
        trending: trendingWith([RANDOM], "weekly"),
      },
    );
    const dailyResult = await inDaily.handler({ goal: "do something" });
    const dailyCands = (dailyResult.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(dailyCands[0]!.sources).toContain("trending");

    const inMonthly = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        fetcher: githubFetcher([
          { html_url: RANDOM, description: "x", stargazers_count: 500, language: "python" },
        ]),
        trending: trendingWith([RANDOM], "monthly"),
      },
    );
    const monthlyResult = await inMonthly.handler({ goal: "do something" });
    const monthlyCands = (monthlyResult.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(monthlyCands[0]!.sources).not.toContain("trending");
  });

  it("raw GitHub-only candidate falls back to popularity scoring", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        fetcher: githubFetcher([
          {
            html_url: RANDOM,
            description: "a random thing",
            stargazers_count: 1000,
            language: "python",
          },
        ]),
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
});

describe("find_repo tool — score stacking and precedence", () => {
  it("learned + community + trending + github all stack on the same repo", async () => {
    const registry: CommunityRegistryClient = {
      fetch: vi.fn(async () => ({
        skills: [{ repo_url: PDFPLUMBER, goal_pattern: "extract tables from pdf documents" }],
      })),
    };
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        learnedSkillRepo: fakeLearnedSkillRepo([makeLearnedSkill({ repo_url: PDFPLUMBER })]),
        communityRegistry: registry,
        fetcher: githubFetcher([
          { html_url: PDFPLUMBER, description: "Plumb a PDF", stargazers_count: 7000, language: "Python" },
        ]),
        trending: trendingWith([PDFPLUMBER], "daily"),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(1);
    const top = candidates[0]!;
    expect(top.sources).toEqual(
      expect.arrayContaining(["learned", "community", "trending", "github"]),
    );
    expect(top.source).toBe("learned"); // precedence: highest wins
    // 50 + 35 + 30 + ~11(popularity for 7000 stars) ≈ 126
    expect(top.score).toBeGreaterThanOrEqual(110);
  });

  it("when only trending + github match, trending wins the source field", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        fetcher: githubFetcher([
          { html_url: RANDOM, description: "x", stargazers_count: 200000, language: "python" },
        ]),
        trending: trendingWith([RANDOM], "daily"),
      },
    );
    const result = await tool.handler({ goal: "anything" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates[0]!.source).toBe("trending");
  });
});

describe("find_repo tool — graceful failure", () => {
  it("GitHub search failure is reported in notes but doesn't fail the call", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        learnedSkillRepo: fakeLearnedSkillRepo([makeLearnedSkill({ repo_url: PDFPLUMBER })]),
        fetcher: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const body = result.content as { candidates: FindRepoCandidate[]; notes: string[] };
    expect(body.candidates).toHaveLength(1); // learned skill survives
    expect(body.notes.some((n) => n.includes("GitHub"))).toBe(true);
  });

  it("learned-skill repo failure is reported in notes but doesn't fail the call", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        learnedSkillRepo: fakeLearnedSkillRepo([], { throws: true }),
        fetcher: githubFetcher([
          { html_url: RANDOM, description: "x", stargazers_count: 1000, language: "python" },
        ]),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const body = result.content as { candidates: FindRepoCandidate[]; notes: string[] };
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.notes.some((n) => n.includes("learned skill"))).toBe(true);
  });

  it("trending lookup failure is reported in notes but doesn't fail the call", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        learnedSkillRepo: fakeLearnedSkillRepo([makeLearnedSkill({ repo_url: PDFPLUMBER })]),
        trending: trendingThrows(),
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const body = result.content as { candidates: FindRepoCandidate[]; notes: string[] };
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.notes.some((n) => n.includes("trending"))).toBe(true);
  });

  it("community registry failure is reported in notes but doesn't fail the call", async () => {
    const failingRegistry: CommunityRegistryClient = {
      fetch: vi.fn(async () => {
        throw new Error("registry fetch failed");
      }),
    };
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        learnedSkillRepo: fakeLearnedSkillRepo([makeLearnedSkill({ repo_url: PDFPLUMBER })]),
        communityRegistry: failingRegistry,
      },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const body = result.content as { candidates: FindRepoCandidate[]; notes: string[] };
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.notes.some((n) => n.includes("community"))).toBe(true);
  });
});

describe("find_repo tool — output shape", () => {
  it("respects the limit param (capped between 1 and 10)", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        fetcher: githubFetcher(
          Array.from({ length: 15 }, (_, i) => ({
            html_url: `https://github.com/owner/repo-${i}`,
            description: `repo number ${i}`,
            stargazers_count: 1000 - i,
            language: "python",
          })),
        ),
      },
    );
    const result = await tool.handler({ goal: "do something", limit: 3 });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates).toHaveLength(3);
  });

  it("returns helpful hint when no candidates match", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      { ...BASE_SERVICES(), fetcher: githubFetcher([]) },
    );
    const result = await tool.handler({ goal: "do something obscure xyzzy" });
    const body = result.content as { candidates: FindRepoCandidate[]; hint: string };
    expect(body.candidates).toHaveLength(0);
    expect(body.hint).toContain("No candidates");
  });

  it("drops github candidates whose description self-describes as such", async () => {
    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      {
        ...BASE_SERVICES(),
        fetcher: githubFetcher([
          {
            html_url: "https://github.com/some-org/their-archive",
            description: "An archive of state propaganda we collect for study",
            stargazers_count: 1000,
          },
          {
            html_url: "https://github.com/legit/tool",
            description: "An actual tool for the user's goal",
            stargazers_count: 500,
          },
        ]),
      },
    );
    const result = await tool.handler({ goal: "anything" });
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(candidates.map((c) => c.repo_url)).toEqual([
      "https://github.com/legit/tool",
    ]);
  });
});

// ── Default HTTP clients ─────────────────────────────────────────────────
//
// Every test above injects a fake `communityRegistry` / `trending`, so the
// clients that actually run in production were never exercised. They are
// the module's whole network boundary: a 5s abort, an hour-long cache, a
// negative cache so an outage doesn't become a hot loop, and shape guards
// on JSON fetched from a public repo. Reached here by building the tool
// with only `fetcher` overridden, which is how production wires it.

describe("find_repo — default community registry client", () => {
  function servicesWithFetcher(fetcher: typeof fetch) {
    // No communityRegistry / trending override: the real HTTP clients.
    return {
      agentRepo: fakeAgentRepo(),
      learnedSkillRepo: fakeLearnedSkillRepo(),
      embeddings: fakeEmbeddingsAllMatch(),
      fetcher,
    };
  }

  function registryFetcher(
    responses: Array<{ ok: boolean; body?: unknown } | "throw">,
  ): { fetcher: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const fetcher = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("api.github.com")) return { ok: true, json: async () => ({ items: [] }) };
      calls.push(u);
      const r = responses[Math.min(i++, responses.length - 1)]!;
      if (r === "throw") throw new Error("ENOTFOUND raw.githubusercontent.com");
      return { ok: r.ok, json: async () => r.body };
    }) as unknown as typeof fetch;
    return { fetcher, calls };
  }

  it("fetches the registry once and serves the rest of the hour from cache", async () => {
    const { fetcher, calls } = registryFetcher([
      { ok: true, body: { skills: [{ repo_url: CAMELOT, goal_pattern: "extract tables" }] } },
    ]);
    const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));

    await tool.handler({ goal: "extract tables from a PDF" });
    const afterFirst = calls.filter((u) => u.includes("registry.json")).length;
    expect(afterFirst).toBe(1);

    // Second call inside the TTL must not hit the network again — the
    // client is per-tool-instance, so this is the same cache.
    await tool.handler({ goal: "extract tables from a PDF" });
    expect(calls.filter((u) => u.includes("registry.json")).length).toBe(1);
  });

  it("notes the registry as unavailable on a non-2xx without failing the search", async () => {
    const { fetcher } = registryFetcher([{ ok: false }]);
    const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));

    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    expect((result.content as { notes: string[] }).notes).toContain(
      "community registry unavailable (proceeding without Tier 1)",
    );
  });

  it("treats a registry payload without a skills array as unavailable", async () => {
    // The file is fetched from a public repo, so a bad deploy there must
    // degrade rather than throw inside the ranker.
    for (const body of [undefined, null, {}, { skills: "not-an-array" }]) {
      const { fetcher } = registryFetcher([{ ok: true, body }]);
      const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));
      const result = await tool.handler({ goal: "extract tables from a PDF" });
      expect(result.isError).toBeFalsy();
      expect((result.content as { notes: string[] }).notes).toContain(
        "community registry unavailable (proceeding without Tier 1)",
      );
    }
  });

  it("swallows a transport failure (including the 5s abort) as unavailable", async () => {
    const { fetcher } = registryFetcher(["throw"]);
    const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect((result.content as { notes: string[] }).notes).toContain(
      "community registry unavailable (proceeding without Tier 1)",
    );
  });

  it("passes an abort signal so a hung registry can't stall the tool", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const fetcher = vi.fn(async (url: unknown, init?: { signal?: AbortSignal }) => {
      if (String(url).includes("registry.json")) seen.push(init?.signal);
      return { ok: true, json: async () => ({ skills: [] }) };
    }) as unknown as typeof fetch;

    await createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher)).handler({
      goal: "extract tables from a PDF",
    });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(false);
  });
});

describe("find_repo — default trending client", () => {
  function servicesWithFetcher(fetcher: typeof fetch) {
    return {
      agentRepo: fakeAgentRepo(),
      learnedSkillRepo: fakeLearnedSkillRepo(),
      embeddings: fakeEmbeddingsAllMatch(),
      fetcher,
      // Keep the registry out of the way; trending is what's under test.
      communityRegistry: emptyCommunityRegistry(),
    };
  }

  function trendingFetcher(
    handler: (period: string) => { ok: boolean; body?: unknown } | "throw",
  ) {
    const periods: string[] = [];
    const fetcher = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("api.github.com")) return { ok: true, json: async () => ({ items: [] }) };
      const m = u.match(/trending-(\w+)\.json/);
      if (!m) return { ok: false, json: async () => ({}) };
      periods.push(m[1]!);
      const r = handler(m[1]!);
      if (r === "throw") throw new Error("socket hang up");
      return { ok: r.ok, json: async () => r.body };
    }) as unknown as typeof fetch;
    return { fetcher, periods };
  }

  it("boosts a candidate that appears in the fetched snapshot", async () => {
    // owner/name/description are what the haystack embeds — an entry
    // with only a URL has no text to embed and is skipped by design.
    const { fetcher } = trendingFetcher(() => ({
      ok: true,
      body: {
        period: "daily",
        repos: [
          {
            repo_url: CAMELOT,
            owner: "camelot-dev",
            name: "camelot",
            description: "PDF table extraction",
            stars_gained: 400,
          },
        ],
      },
    }));
    const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));

    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    // The snapshot entry is injected even though GitHub search returned
    // nothing — that is the point of the inject pass.
    expect(candidates.some((c) => normalizeForTest(c.repo_url) === normalizeForTest(CAMELOT))).toBe(
      true,
    );
  });

  it("caches each period separately for the hour", async () => {
    const { fetcher, periods } = trendingFetcher(() => ({
      ok: true,
      body: { period: "daily", repos: [] },
    }));
    const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));

    await tool.handler({ goal: "extract tables from a PDF" });
    const first = [...periods];
    expect(first.length).toBeGreaterThan(0);

    await tool.handler({ goal: "extract tables from a PDF" });
    // Same periods, no new fetches.
    expect(periods).toEqual(first);
  });

  it("negative-caches a non-2xx so an outage is not a hot loop", async () => {
    const { fetcher, periods } = trendingFetcher(() => ({ ok: false }));
    const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));

    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const afterFirst = periods.length;

    await tool.handler({ goal: "extract tables from a PDF" });
    // The empty result is cached under the same TTL, so the second search
    // does not re-hit raw.githubusercontent during the outage.
    expect(periods.length).toBe(afterFirst);
  });

  it("negative-caches a transport throw too", async () => {
    const { fetcher, periods } = trendingFetcher(() => "throw");
    const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));

    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    const afterFirst = periods.length;
    await tool.handler({ goal: "extract tables from a PDF" });
    expect(periods.length).toBe(afterFirst);
  });

  it("tolerates a snapshot whose repos field isn't an array", async () => {
    const { fetcher } = trendingFetcher(() => ({
      ok: true,
      body: { period: "daily", repos: { not: "an array" } },
    }));
    const tool = createFindRepoTool({ agentId: AGENT_ID }, servicesWithFetcher(fetcher));
    const result = await tool.handler({ goal: "extract tables from a PDF" });
    expect(result.isError).toBeFalsy();
    expect((result.content as { candidates: FindRepoCandidate[] }).candidates).toEqual([]);
  });
});

// ── Remaining degradation paths ──────────────────────────────────────────

describe("find_repo — degradation", () => {
  it("skips the semantic tiers and says so when embedding the goal fails", async () => {
    // Without the note the agent can't tell a thin result set from a
    // provider outage that silently dropped trending + community.
    const embeddings = {
      type: "fake:broken",
      embed: vi.fn(async () => {
        throw new Error("openai 503");
      }),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
    } as unknown as EmbeddingService;

    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      { ...BASE_SERVICES(), embeddings },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });

    expect(result.isError).toBeFalsy();
    expect((result.content as { notes: string[] }).notes).toContain(
      "embedding goal failed (semantic tiers skipped): openai 503",
    );
  });

  it("notes a GitHub search that answers non-2xx", async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: "rate limit exceeded" }),
    })) as unknown as typeof fetch;

    const tool = createFindRepoTool(
      { agentId: AGENT_ID },
      { ...BASE_SERVICES(), fetcher },
    );
    const result = await tool.handler({ goal: "extract tables from a PDF" });

    expect(result.isError).toBeFalsy();
    // The status is carried through so a 403 (rate limit) is
    // distinguishable from a 422 (bad query) in the transcript.
    expect((result.content as { notes: string[] }).notes).toContain(
      "GitHub search failed: GitHub search 403",
    );
  });
});

describe("find_repo — trending embedding cache", () => {
  it("embeds a snapshot entry once and reuses the vector on later searches", async () => {
    // Snapshots that predate the precomputed-embedding field arrive with
    // no `embedding`, so every entry would otherwise be re-embedded on
    // each search — a paid provider call per repo per call.
    const UNCACHED = "https://github.com/cache-probe/widget";
    const fetcher = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("api.github.com")) return { ok: true, json: async () => ({ items: [] }) };
      if (u.includes("trending-daily.json")) {
        return {
          ok: true,
          json: async () => ({
            period: "daily",
            repos: [
              {
                repo_url: UNCACHED,
                owner: "cache-probe",
                name: "widget",
                description: "extract tables from documents",
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ period: "weekly", repos: [] }) };
    }) as unknown as typeof fetch;

    const embeddings = fakeEmbeddingsAllMatch();
    const services = {
      agentRepo: fakeAgentRepo(),
      learnedSkillRepo: fakeLearnedSkillRepo(),
      embeddings,
      fetcher,
      communityRegistry: emptyCommunityRegistry(),
    };

    // Two separate tool instances, so the snapshot is fetched afresh and
    // only the module-level embedding cache can prevent the second embed.
    await createFindRepoTool({ agentId: AGENT_ID }, services).handler({
      goal: "extract tables from a PDF",
    });
    const afterFirst = vi.mocked(embeddings.embedBatch).mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await createFindRepoTool({ agentId: AGENT_ID }, services).handler({
      goal: "extract tables from a PDF",
    });
    expect(vi.mocked(embeddings.embedBatch).mock.calls.length).toBe(afterFirst);
  });

  it("uses an entry's precomputed embedding instead of calling the provider", async () => {
    // fetch-trending.ts writes `embedding` into the snapshot so the read
    // path costs no provider calls at all. A regression here turns every
    // find_repo into one embed per trending repo.
    const PRECOMPUTED = "https://github.com/precomputed/repo";
    const fetcher = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("api.github.com")) return { ok: true, json: async () => ({ items: [] }) };
      if (u.includes("trending-daily.json")) {
        return {
          ok: true,
          json: async () => ({
            period: "daily",
            repos: [
              {
                repo_url: PRECOMPUTED,
                owner: "precomputed",
                name: "repo",
                description: "extract tables from documents",
                // Same vector the fake embedder returns for the goal, so
                // it clears SIM_THRESHOLD and gets injected.
                embedding: [1, 0],
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ period: "weekly", repos: [] }) };
    }) as unknown as typeof fetch;

    const embeddings = fakeEmbeddingsAllMatch();
    const result = await createFindRepoTool(
      { agentId: AGENT_ID },
      {
        agentRepo: fakeAgentRepo(),
        learnedSkillRepo: fakeLearnedSkillRepo(),
        embeddings,
        fetcher,
        communityRegistry: emptyCommunityRegistry(),
      },
    ).handler({ goal: "extract tables from a PDF" });

    const candidates = (result.content as { candidates: FindRepoCandidate[] }).candidates;
    expect(
      candidates.some((c) => normalizeForTest(c.repo_url) === normalizeForTest(PRECOMPUTED)),
    ).toBe(true);
    // The goal still needs one embed; the entry itself needs none.
    expect(embeddings.embedBatch).not.toHaveBeenCalled();
  });
});
