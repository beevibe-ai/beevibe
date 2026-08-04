/**
 * Mock-Pool tests for views/memory-activity.ts.
 *
 * The view fans out to seven queries (plus two more when `since` is set)
 * via `Promise.all`. The array elements are evaluated left to right and
 * each helper runs synchronously up to its `pool.query`, so the call
 * order is deterministic and the ordered `makeMockPool([[...], ...])`
 * shape lines up 1:1 with QUERY below.
 *
 * What's actually under test is the mapping layer: Postgres returns
 * COUNT() as a string and `::date` as a JS Date, so every numeric field
 * goes through `Number()` and every date through `localDate()`. The
 * ratio fields additionally guard divide-by-zero.
 */
import { describe, it, expect } from "vitest";
import { getMemoryActivity } from "./memory-activity.js";
import { makeMockPool } from "./test-helpers.js";

/** Index of each query in the ordered mock-pool response array. */
const QUERY = {
  weekly: 0,
  scopeType: 1,
  topAgents: 2,
  dormant: 3,
  coreSnapshot: 4,
  ratio: 5,
  kpis: 6,
  beforeAfterByType: 7,
  beforeAfterAgg: 8,
} as const;

const KPI_ROW = {
  archival_writes_30d: "0",
  core_touched_30d: "0",
  active_agents_30d: "0",
};

/**
 * `localDate` reads local-timezone components, mirroring how node-postgres
 * parses a `::date` column (local midnight). Building fixtures the same way
 * keeps assertions stable regardless of the runner's TZ.
 */
function localMidnight(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

/** Ordered responses with every slot empty except the ones provided. */
function responses(overrides: Partial<Record<number, unknown[]>>): unknown[][] {
  const slots: unknown[][] = Array.from({ length: 9 }, () => []);
  slots[QUERY.kpis] = [KPI_ROW];
  for (const [i, rows] of Object.entries(overrides)) {
    slots[Number(i)] = rows as unknown[];
  }
  return slots;
}

describe("getMemoryActivity — options", () => {
  it("passes the requested window to the interval-scoped queries", async () => {
    const pool = makeMockPool(responses({}));
    const summary = await getMemoryActivity(pool, { weeks: 8 });
    expect(summary.weeks).toBe(8);
    expect(pool._spy.mock.calls[QUERY.weekly]![1]).toEqual(["8 weeks"]);
    expect(pool._spy.mock.calls[QUERY.scopeType]![1]).toEqual(["8 weeks"]);
  });

  it.each([
    ["clamps above the max", 999, 52],
    ["clamps at the max boundary", 52, 52],
    ["accepts the min", 1, 1],
    ["truncates a fractional week count", 8.9, 8],
  ])("%s", async (_label, input, expected) => {
    const pool = makeMockPool(responses({}));
    const summary = await getMemoryActivity(pool, { weeks: input });
    expect(summary.weeks).toBe(expected);
  });

  it.each([
    ["below the min", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("falls back to 12 weeks when weeks is %s", async (_label, input) => {
    const pool = makeMockPool(responses({}));
    const summary = await getMemoryActivity(pool, { weeks: input });
    expect(summary.weeks).toBe(12);
  });

  it("omits before_after and reports since=null when no since is given", async () => {
    const pool = makeMockPool(responses({}));
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.since).toBeNull();
    expect(summary.before_after).toBeUndefined();
    // Only the seven always-on queries ran.
    expect(pool._spy).toHaveBeenCalledTimes(7);
  });
});

describe("getMemoryActivity — mapping", () => {
  it("returns empty collections when nothing has been written", async () => {
    const pool = makeMockPool(responses({}));
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary).toMatchObject({
      weekly_archival: [],
      by_scope_and_type: [],
      top_agents: [],
      dormant_agents: [],
      core_snapshot: [],
      archival_to_core_per_agent: [],
    });
  });

  it("coerces the weekly counts to numbers and the bucket to YYYY-MM-DD", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.weekly]: [
          {
            week: localMidnight(2026, 4, 6),
            total: "42",
            belief: "10",
            pattern: "12",
            gotcha: "8",
            preference: "7",
            decision: "5",
            active_agents: "3",
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.weekly_archival).toEqual([
      {
        week: "2026-04-06",
        total: 42,
        belief: 10,
        pattern: 12,
        gotcha: 8,
        preference: 7,
        decision: 5,
        active_agents: 3,
      },
    ]);
  });

  it("zero-pads single-digit months and days in date buckets", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.weekly]: [
          {
            week: localMidnight(2026, 1, 5),
            total: "1",
            belief: "0",
            pattern: "0",
            gotcha: "0",
            preference: "0",
            decision: "1",
            active_agents: "1",
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.weekly_archival[0]!.week).toBe("2026-01-05");
  });

  it("maps the scope × type breakdown", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.scopeType]: [
          { scope: "ic", fact_type: "pattern", writes: "9" },
          { scope: "team", fact_type: "gotcha", writes: "4" },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.by_scope_and_type).toEqual([
      { scope: "ic", fact_type: "pattern", writes: 9 },
      { scope: "team", fact_type: "gotcha", writes: 4 },
    ]);
  });

  it("renames id → agent_id and formats last_write for top agents", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.topAgents]: [
          {
            id: "agt_1",
            name: "Alice",
            tier: "ic",
            writes_30d: "31",
            type_variety: "4",
            last_write: localMidnight(2026, 4, 29),
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.top_agents).toEqual([
      {
        agent_id: "agt_1",
        name: "Alice",
        tier: "ic",
        writes_30d: 31,
        type_variety: 4,
        last_write: "2026-04-29",
      },
    ]);
  });

  it("keeps last_write_ever null for an agent that has never written", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.dormant]: [
          {
            id: "agt_new",
            name: "Newbie",
            tier: "ic",
            last_write_ever: null,
            agent_created: localMidnight(2026, 4, 20),
          },
          {
            id: "agt_stale",
            name: "Stale",
            tier: "team",
            last_write_ever: localMidnight(2026, 2, 1),
            agent_created: localMidnight(2026, 1, 15),
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.dormant_agents).toEqual([
      {
        agent_id: "agt_new",
        name: "Newbie",
        tier: "ic",
        last_write_ever: null,
        agent_created: "2026-04-20",
      },
      {
        agent_id: "agt_stale",
        name: "Stale",
        tier: "team",
        last_write_ever: "2026-02-01",
        agent_created: "2026-01-15",
      },
    ]);
  });

  it("maps the core snapshot, treating a null AVG as 0 chars", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.coreSnapshot]: [
          {
            tier: "ic",
            block_name: "persona",
            blocks: "5",
            non_empty: "4",
            ever_updated: "3",
            updated_30d: "1",
            avg_chars: "812",
          },
          {
            tier: "ic",
            block_name: "scratch",
            blocks: "5",
            non_empty: "0",
            ever_updated: "0",
            updated_30d: "0",
            avg_chars: null,
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.core_snapshot[0]!.avg_chars).toBe(812);
    expect(summary.core_snapshot[1]!.avg_chars).toBe(0);
  });
});

describe("getMemoryActivity — ratios", () => {
  it("rounds the per-agent archival:core ratio to one decimal", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.ratio]: [
          {
            id: "agt_1",
            name: "Alice",
            tier: "ic",
            archival_30d: "10",
            core_touched_30d: "3",
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    // 10/3 = 3.333… → 3.3
    expect(summary.archival_to_core_per_agent[0]).toEqual({
      agent_id: "agt_1",
      name: "Alice",
      tier: "ic",
      archival_30d: 10,
      core_touched_30d: 3,
      ratio: 3.3,
    });
  });

  it("returns a null per-agent ratio rather than Infinity when core is 0", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.ratio]: [
          {
            id: "agt_1",
            name: "Alice",
            tier: "ic",
            archival_30d: "7",
            core_touched_30d: "0",
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.archival_to_core_per_agent[0]!.ratio).toBeNull();
  });

  it("coerces the KPI counts and rounds the overall ratio", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.kpis]: [
          {
            archival_writes_30d: "125",
            core_touched_30d: "20",
            active_agents_30d: "9",
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.kpis).toEqual({
      archival_writes_30d: 125,
      core_touched_30d: 20,
      active_agents_30d: 9,
      archival_to_core_ratio: 6.3,
    });
  });

  it("returns a null overall ratio when nothing touched core memory", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.kpis]: [
          {
            archival_writes_30d: "40",
            core_touched_30d: "0",
            active_agents_30d: "4",
          },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12 });
    expect(summary.kpis.archival_to_core_ratio).toBeNull();
  });
});

describe("getMemoryActivity — before/after split", () => {
  const since = "2026-04-15T00:00:00Z";

  it("runs the two extra queries with the since cutoff and echoes it back", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.beforeAfterAgg]: [
          { agents_pre: "3", agents_post: "5", writes_pre: "40", writes_post: "70" },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12, since });
    expect(pool._spy).toHaveBeenCalledTimes(9);
    expect(pool._spy.mock.calls[QUERY.beforeAfterByType]![1]).toEqual([since]);
    expect(pool._spy.mock.calls[QUERY.beforeAfterAgg]![1]).toEqual([since]);
    expect(summary.since).toBe(since);
    expect(summary.before_after).toEqual({
      since,
      by_type: [],
      agg: { agents_pre: 3, agents_post: 5, writes_pre: 40, writes_post: 70 },
    });
  });

  it("coerces the per-type pre/post counts and percentages", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.beforeAfterByType]: [
          {
            fact_type: "pattern",
            pre: "12",
            post: "30",
            pre_pct: "30.0",
            post_pct: "42.9",
          },
        ],
        [QUERY.beforeAfterAgg]: [
          { agents_pre: "3", agents_post: "5", writes_pre: "40", writes_post: "70" },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12, since });
    expect(summary.before_after?.by_type).toEqual([
      { fact_type: "pattern", pre: 12, post: 30, pre_pct: 30, post_pct: 42.9 },
    ]);
  });

  it("keeps a null percentage null instead of coercing it to 0", async () => {
    const pool = makeMockPool(
      responses({
        [QUERY.beforeAfterByType]: [
          {
            fact_type: "decision",
            pre: "0",
            post: "4",
            pre_pct: null,
            post_pct: "100.0",
          },
        ],
        [QUERY.beforeAfterAgg]: [
          { agents_pre: "0", agents_post: "2", writes_pre: "0", writes_post: "4" },
        ],
      }),
    );
    const summary = await getMemoryActivity(pool, { weeks: 12, since });
    expect(summary.before_after?.by_type[0]).toMatchObject({
      pre_pct: null,
      post_pct: 100,
    });
  });
});
