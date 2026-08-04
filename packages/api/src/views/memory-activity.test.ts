/**
 * Tests for views/memory-activity.ts — the Layer A telemetry composer
 * behind /memory/eval.
 *
 * Eight queries fan out under one `Promise.all`, so the mock pool here
 * routes by a distinctive fragment of each statement rather than by
 * call order: an ordered fixture would silently re-pair rows with the
 * wrong mapper the day someone reorders the array.
 *
 * What's actually worth asserting past the row → DTO mapping:
 *   - `weeks` clamping (1..52, non-finite → default 12) since it goes
 *     straight into the `$1::interval` string,
 *   - the two ratio computations, which divide by a core-touch count
 *     that is routinely zero and must yield null rather than Infinity,
 *   - `localDate`, which exists specifically so a `::date` column
 *     parsed at local midnight doesn't shift a day under `toISOString`,
 *   - `before_after` being omitted entirely without `since`.
 */
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { getMemoryActivity } from "./memory-activity.js";

/**
 * Route each query to rows by matching a fragment unique to it. Any
 * statement without a registered fragment resolves to zero rows, which
 * keeps a test that only cares about one section short.
 */
type Fixture = Record<string, unknown[]>;

function makeRoutingPool(fixture: Fixture): Pool & { _spy: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string) => {
    for (const [fragment, rows] of Object.entries(fixture)) {
      if (sql.includes(fragment)) return { rows };
    }
    return { rows: [] };
  });
  return { query, _spy: query } as unknown as Pool & {
    _spy: ReturnType<typeof vi.fn>;
  };
}

/** KPI query returns exactly one row; the composer indexes [0] unguarded. */
const KPI_ZERO = {
  archival_writes_30d: "0",
  core_touched_30d: "0",
  active_agents_30d: "0",
};

const BASE: Fixture = { archival_writes_30d: [KPI_ZERO] };

/** A `::date` column: node-postgres hands back local midnight. */
function localMidnight(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

describe("getMemoryActivity — weeks clamping", () => {
  it("passes the requested window through as a Postgres interval string", async () => {
    const pool = makeRoutingPool(BASE);
    const out = await getMemoryActivity(pool, { weeks: 8 });
    expect(out.weeks).toBe(8);
    expect(pool._spy).toHaveBeenCalledWith(
      expect.stringContaining("date_trunc('week'"),
      ["8 weeks"],
    );
  });

  it("clamps above 52", async () => {
    const pool = makeRoutingPool(BASE);
    const out = await getMemoryActivity(pool, { weeks: 400 });
    expect(out.weeks).toBe(52);
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["52 weeks"]);
  });

  it("falls back to 12 for values below the floor", async () => {
    const pool = makeRoutingPool(BASE);
    expect((await getMemoryActivity(pool, { weeks: 0 })).weeks).toBe(12);
    expect((await getMemoryActivity(pool, { weeks: -5 })).weeks).toBe(12);
  });

  it("falls back to 12 for a non-finite value", async () => {
    const pool = makeRoutingPool(BASE);
    expect((await getMemoryActivity(pool, { weeks: NaN })).weeks).toBe(12);
    expect((await getMemoryActivity(pool, { weeks: Infinity })).weeks).toBe(12);
  });

  it("truncates a fractional window", async () => {
    const pool = makeRoutingPool(BASE);
    expect((await getMemoryActivity(pool, { weeks: 6.9 })).weeks).toBe(6);
  });
});

describe("getMemoryActivity — row mapping", () => {
  it("coerces the weekly counts from Postgres bigint strings to numbers", async () => {
    const pool = makeRoutingPool({
      ...BASE,
      "date_trunc('week'": [
        {
          week: localMidnight(2026, 4, 27),
          total: "42",
          belief: "10",
          pattern: "12",
          gotcha: "8",
          preference: "7",
          decision: "5",
          active_agents: "6",
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.weekly_archival).toEqual([
      {
        week: "2026-04-27",
        total: 42,
        belief: 10,
        pattern: 12,
        gotcha: 8,
        preference: 7,
        decision: 5,
        active_agents: 6,
      },
    ]);
  });

  it("keeps a ::date on its local calendar day rather than shifting under UTC", async () => {
    // Local midnight on the 1st is the previous day in UTC for any
    // negative offset; the view must still report "2026-06-01".
    const pool = makeRoutingPool({
      ...BASE,
      "date_trunc('week'": [
        {
          week: localMidnight(2026, 6, 1),
          total: "1",
          belief: "0",
          pattern: "0",
          gotcha: "0",
          preference: "0",
          decision: "1",
          active_agents: "1",
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 1 });
    expect(out.weekly_archival[0]?.week).toBe("2026-06-01");
  });

  it("maps the scope × type breakdown", async () => {
    const pool = makeRoutingPool({
      ...BASE,
      "GROUP BY scope, fact_type": [
        { scope: "team", fact_type: "pattern", writes: "9" },
        { scope: "ic", fact_type: "gotcha", writes: "3" },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.by_scope_and_type).toEqual([
      { scope: "team", fact_type: "pattern", writes: 9 },
      { scope: "ic", fact_type: "gotcha", writes: 3 },
    ]);
  });

  it("maps top agents, renaming id → agent_id", async () => {
    const pool = makeRoutingPool({
      ...BASE,
      type_variety: [
        {
          id: "agt_1",
          name: "Comms",
          tier: "ic",
          writes_30d: "31",
          type_variety: "4",
          last_write: localMidnight(2026, 5, 3),
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.top_agents).toEqual([
      {
        agent_id: "agt_1",
        name: "Comms",
        tier: "ic",
        writes_30d: 31,
        type_variety: 4,
        last_write: "2026-05-03",
      },
    ]);
  });

  it("maps dormant agents, keeping last_write_ever null for one that never wrote", async () => {
    const pool = makeRoutingPool({
      ...BASE,
      last_write_ever: [
        {
          id: "agt_new",
          name: "Fresh hire",
          tier: "ic",
          last_write_ever: null,
          agent_created: localMidnight(2026, 5, 1),
        },
        {
          id: "agt_quiet",
          name: "Quiet one",
          tier: "team",
          last_write_ever: localMidnight(2026, 2, 14),
          agent_created: localMidnight(2026, 1, 2),
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.dormant_agents).toEqual([
      {
        agent_id: "agt_new",
        name: "Fresh hire",
        tier: "ic",
        last_write_ever: null,
        agent_created: "2026-05-01",
      },
      {
        agent_id: "agt_quiet",
        name: "Quiet one",
        tier: "team",
        last_write_ever: "2026-02-14",
        agent_created: "2026-01-02",
      },
    ]);
  });

  it("maps the core snapshot, reading a null AVG as 0 chars", async () => {
    const pool = makeRoutingPool({
      ...BASE,
      "cmb.block_name": [
        {
          tier: "ic",
          block_name: "persona",
          blocks: "5",
          non_empty: "4",
          ever_updated: "3",
          updated_30d: "1",
          avg_chars: "820",
        },
        {
          tier: "team",
          block_name: "tag_line",
          blocks: "2",
          non_empty: "0",
          ever_updated: "0",
          updated_30d: "0",
          avg_chars: null,
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.core_snapshot[0]?.avg_chars).toBe(820);
    expect(out.core_snapshot[1]?.avg_chars).toBe(0);
  });
});

describe("getMemoryActivity — ratio math", () => {
  it("rounds the per-agent ratio to one decimal", async () => {
    const pool = makeRoutingPool({
      ...BASE,
      "LEFT JOIN LATERAL": [
        {
          id: "agt_1",
          name: "Comms",
          tier: "ic",
          archival_30d: "10",
          core_touched_30d: "3",
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.archival_to_core_per_agent[0]).toEqual({
      agent_id: "agt_1",
      name: "Comms",
      tier: "ic",
      archival_30d: 10,
      core_touched_30d: 3,
      ratio: 3.3,
    });
  });

  it("reports a null per-agent ratio instead of Infinity when core touches are zero", async () => {
    const pool = makeRoutingPool({
      ...BASE,
      "LEFT JOIN LATERAL": [
        {
          id: "agt_1",
          name: "Comms",
          tier: "ic",
          archival_30d: "7",
          core_touched_30d: "0",
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.archival_to_core_per_agent[0]?.ratio).toBeNull();
  });

  it("computes the KPI ratio the same way", async () => {
    const pool = makeRoutingPool({
      archival_writes_30d: [
        {
          archival_writes_30d: "25",
          core_touched_30d: "4",
          active_agents_30d: "9",
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.kpis).toEqual({
      archival_writes_30d: 25,
      core_touched_30d: 4,
      active_agents_30d: 9,
      archival_to_core_ratio: 6.3,
    });
  });

  it("nulls the KPI ratio when nothing touched core memory", async () => {
    const pool = makeRoutingPool({
      archival_writes_30d: [
        {
          archival_writes_30d: "25",
          core_touched_30d: "0",
          active_agents_30d: "9",
        },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.kpis.archival_to_core_ratio).toBeNull();
  });
});

describe("getMemoryActivity — before/after split", () => {
  it("omits before_after and reports since: null when ?since= is absent", async () => {
    const pool = makeRoutingPool(BASE);
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out.since).toBeNull();
    expect(out.before_after).toBeUndefined();
    // Neither of the two windowed queries should have run.
    const sqls = pool._spy.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("WITH win AS"))).toBe(false);
  });

  it("runs both windowed queries with the cutoff and assembles the split", async () => {
    const since = "2026-05-01T00:00:00Z";
    const pool = makeRoutingPool({
      ...BASE,
      "GROUP BY fact_type": [
        { fact_type: "belief", pre: "4", post: "6", pre_pct: "40.0", post_pct: "60.0" },
      ],
      "COUNT(DISTINCT agent_id) FILTER": [
        { agents_pre: "3", agents_post: "5", writes_pre: "10", writes_post: "14" },
      ],
    });
    const out = await getMemoryActivity(pool, { weeks: 12, since });
    expect(out.since).toBe(since);
    expect(out.before_after).toEqual({
      since,
      by_type: [
        { fact_type: "belief", pre: 4, post: 6, pre_pct: 40, post_pct: 60 },
      ],
      agg: { agents_pre: 3, agents_post: 5, writes_pre: 10, writes_post: 14 },
    });
    expect(pool._spy).toHaveBeenCalledWith(
      expect.stringContaining("GROUP BY fact_type"),
      [since],
    );
  });

  it("keeps a null percentage null rather than coercing it to 0", async () => {
    // NULLIF guards a zero denominator, so an empty half of the window
    // yields SQL NULL — "no data" must not render as "0% of writes".
    const pool = makeRoutingPool({
      ...BASE,
      "GROUP BY fact_type": [
        { fact_type: "gotcha", pre: "0", post: "3", pre_pct: null, post_pct: "100.0" },
      ],
      "COUNT(DISTINCT agent_id) FILTER": [
        { agents_pre: "0", agents_post: "2", writes_pre: "0", writes_post: "3" },
      ],
    });
    const out = await getMemoryActivity(pool, {
      weeks: 12,
      since: "2026-05-01T00:00:00Z",
    });
    expect(out.before_after?.by_type[0]?.pre_pct).toBeNull();
    expect(out.before_after?.by_type[0]?.post_pct).toBe(100);
  });
});

describe("getMemoryActivity — empty database", () => {
  it("returns every section as an empty array with zeroed KPIs", async () => {
    const pool = makeRoutingPool(BASE);
    const out = await getMemoryActivity(pool, { weeks: 12 });
    expect(out).toEqual({
      weeks: 12,
      since: null,
      kpis: {
        archival_writes_30d: 0,
        core_touched_30d: 0,
        active_agents_30d: 0,
        archival_to_core_ratio: null,
      },
      weekly_archival: [],
      by_scope_and_type: [],
      top_agents: [],
      dormant_agents: [],
      core_snapshot: [],
      archival_to_core_per_agent: [],
      before_after: undefined,
    });
  });
});
