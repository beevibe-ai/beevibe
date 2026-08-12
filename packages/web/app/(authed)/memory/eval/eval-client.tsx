"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, BarChart3 } from "lucide-react";
import { useMemoryActivity } from "@/lib/hooks/use-memory-activity";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { DatePicker, todayIso } from "@/components/date-picker";
import { cn } from "@/lib/utils";
import type {
  AgentActivityRow,
  AgentRatioRow,
  BeforeAfterData,
  CoreSnapshotRow,
  DormantAgentRow,
  MemoryActivityKpis,
  MemoryActivitySummary,
  ScopeTypeRow,
  WeeklyArchivalRow,
} from "@/lib/api/types";

const FACT_TYPES = ["belief", "pattern", "gotcha", "preference", "decision"] as const;
type FactType = (typeof FACT_TYPES)[number];

// Use the same design tokens that drive FactTypeTag on /memory so the
// chart's colour assignment matches what users see on individual facts.
// Tailwind extends fill-* with the color palette, so `fill-type-{ft}-fg`
// resolves to the same HSL var as `bg-type-{ft}-fg`.
const TYPE_COLOR: Record<FactType, { fill: string; dot: string }> = {
  belief: { fill: "fill-type-belief-fg", dot: "bg-type-belief-fg" },
  pattern: { fill: "fill-type-pattern-fg", dot: "bg-type-pattern-fg" },
  gotcha: { fill: "fill-type-gotcha-fg", dot: "bg-type-gotcha-fg" },
  preference: { fill: "fill-type-preference-fg", dot: "bg-type-preference-fg" },
  decision: { fill: "fill-type-decision-fg", dot: "bg-type-decision-fg" },
};

export function MemoryEvalClient() {
  const [weeks, setWeeks] = useState(12);
  // Default to today so the before/after panel is discoverable on first
  // load. Users can clear or pick a different boundary from the calendar.
  const [since, setSince] = useState<string>(() => todayIso());

  // queryKey uses structural equality, so no useMemo wrap needed.
  const params = { weeks, since: since || undefined };

  const { data, isLoading, isError } = useMemoryActivity(params);

  if (!isApiConfigured) {
    return (
      <EmptyState
        icon={BarChart3}
        title="Memory eval not connected"
        description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load Layer A activity telemetry."
      />
    );
  }
  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load memory activity"
        description="Check that the api server is reachable."
      />
    );
  }

  return (
    <div className="space-y-10">
      <Header
        weeks={weeks}
        onWeeksChange={setWeeks}
        since={since}
        onSinceChange={setSince}
      />
      {isLoading || !data ? <LoadingState /> : <Body data={data} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Header + controls
// ─────────────────────────────────────────────────────────────────────────

function Header({
  weeks,
  onWeeksChange,
  since,
  onSinceChange,
}: {
  weeks: number;
  onWeeksChange: (n: number) => void;
  since: string;
  onSinceChange: (s: string) => void;
}) {
  return (
    <header className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link
          href="/memory"
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          Memory
        </Link>
        <span>/</span>
        <span className="text-foreground">Eval</span>
      </div>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Memory eval</h1>
        <p className="mt-1 text-sm text-muted-foreground max-w-prose">
          Activity-level signal on what got written, by whom, when, and of what
          type. Not a quality metric — the cheap first cut on whether memory
          tooling is doing what we want.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Window</span>
          <select
            value={weeks}
            onChange={(e) => onWeeksChange(Number(e.target.value))}
            className="bg-background border border-border rounded px-2 py-1"
          >
            {[4, 8, 12, 26, 52].map((w) => (
              <option key={w} value={w}>
                {w} weeks
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Compare around</span>
          <DatePicker
            value={since}
            onChange={onSinceChange}
            onClear={() => onSinceChange("")}
            ariaLabel="Compare around date"
          />
        </div>
      </div>
    </header>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-60 rounded-lg" />
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Body — all sections
// ─────────────────────────────────────────────────────────────────────────

function Body({ data }: { data: MemoryActivitySummary }) {
  return (
    <>
      <KpiRow kpis={data.kpis} />
      <WeeklyChart rows={data.weekly_archival} />
      <ScopeTypeSection rows={data.by_scope_and_type} />
      <div className="grid md:grid-cols-2 gap-6">
        <TopAgentsTable rows={data.top_agents} />
        <DormantAgentsTable rows={data.dormant_agents} />
      </div>
      <CoreSnapshotTable rows={data.core_snapshot} />
      <RatioTable rows={data.archival_to_core_per_agent} />
      {data.before_after ? <BeforeAfterPanel data={data.before_after} /> : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// KPI tiles
// ─────────────────────────────────────────────────────────────────────────

function KpiRow({ kpis }: { kpis: MemoryActivityKpis }) {
  const tiles = [
    { label: "Archival writes · 30d", value: fmt(kpis.archival_writes_30d) },
    { label: "Core blocks touched · 30d", value: fmt(kpis.core_touched_30d) },
    { label: "Active writing agents · 30d", value: fmt(kpis.active_agents_30d) },
    {
      label: "Archival ÷ core touches",
      value: kpis.archival_to_core_ratio === null
        ? "—"
        : kpis.archival_to_core_ratio.toString(),
      caption:
        kpis.archival_to_core_ratio === null
          ? "no core touches"
          : "higher = more archival-biased",
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg glass-surface p-4">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
            {t.label}
          </div>
          <div className="text-2xl font-semibold tabular-nums">{t.value}</div>
          {"caption" in t && t.caption ? (
            <div className="text-[10px] text-muted-foreground mt-1">
              {t.caption}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Weekly trend — stacked SVG bars per fact_type
// ─────────────────────────────────────────────────────────────────────────

function WeeklyChart({ rows }: { rows: WeeklyArchivalRow[] }) {
  if (!rows.length) {
    return (
      <Card title="Archival writes · weekly" subtitle="no writes in window" />
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.total));
  const w = 700;
  const h = 200;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const slot = innerW / rows.length;
  const barW = Math.min(40, slot * 0.7);
  const total = rows.reduce((a, r) => a + r.total, 0);

  return (
    <Card title="Archival writes · weekly" subtitle={`${total} total`}>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full h-auto text-muted-foreground"
        >
          {/* Y-axis ticks */}
          {[0, 0.5, 1].map((t) => {
            const y = padT + innerH * (1 - t);
            return (
              <g key={t}>
                <line
                  x1={padL}
                  x2={w - padR}
                  y1={y}
                  y2={y}
                  className="stroke-border/40"
                  strokeDasharray="2 3"
                />
                <text
                  x={padL - 6}
                  y={y}
                  className="fill-current text-[10px]"
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {Math.round(max * t)}
                </text>
              </g>
            );
          })}
          {/* Stacked bars */}
          {rows.map((r, i) => {
            const x = padL + slot * i + (slot - barW) / 2;
            let y = padT + innerH;
            return (
              <g key={r.week}>
                {FACT_TYPES.map((ft) => {
                  const v = r[ft] as number;
                  if (!v) return null;
                  const hh = (v / max) * innerH;
                  y -= hh;
                  return (
                    <rect
                      key={ft}
                      x={x}
                      y={y}
                      width={barW}
                      height={hh}
                      className={TYPE_COLOR[ft].fill}
                    >
                      <title>{`${r.week} · ${ft}: ${v}`}</title>
                    </rect>
                  );
                })}
                <text
                  x={x + barW / 2}
                  y={h - padB + 14}
                  className="fill-current text-[9px]"
                  textAnchor="middle"
                >
                  {r.week.slice(5)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Legend />
    </Card>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground mt-2">
      {FACT_TYPES.map((ft) => (
        <span key={ft} className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-sm ${TYPE_COLOR[ft].dot}`} />
          {ft}
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Scope × fact_type breakdown
// ─────────────────────────────────────────────────────────────────────────

function ScopeTypeSection({ rows }: { rows: ScopeTypeRow[] }) {
  // Pivot to scope × fact_type matrix.
  const scopes: Array<"ic" | "team" | "org"> = ["ic", "team", "org"];
  const byScope: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    byScope[r.scope] = byScope[r.scope] ?? {};
    byScope[r.scope]![r.fact_type] = r.writes;
  }
  const columns: Array<StatColumn<(typeof scopes)[number]>> = [
    {
      header: "Scope",
      align: "left",
      className: "text-foreground",
      cell: (scope) => scope,
    },
    ...FACT_TYPES.map((ft) => ({
      header: ft,
      cell: (scope: (typeof scopes)[number]) => {
        const writes = byScope[scope]?.[ft];
        return writes ? fmt(writes) : "—";
      },
    })),
    {
      header: "Total",
      className: "font-semibold",
      cell: (scope) => {
        const total = Object.values(byScope[scope] ?? {}).reduce((a, b) => a + b, 0);
        return total ? fmt(total) : "—";
      },
    },
  ];
  return (
    <Card title="Archival writes · scope × fact_type">
      <StatTable columns={columns} rows={scopes} rowKey={(scope) => scope} />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Top + dormant agents
// ─────────────────────────────────────────────────────────────────────────

/** Agent name + tier — the two leading columns every per-agent table opens with. */
function agentIdentityColumns<T extends { agent_id: string; name: string; tier: string }>(
  maxWidth = "max-w-[160px]",
): Array<StatColumn<T>> {
  return [
    {
      header: "Agent",
      align: "left",
      className: `text-foreground truncate ${maxWidth}`,
      cell: (r) => <AgentLink id={r.agent_id} name={r.name} />,
    },
    { header: "Tier", align: "left", className: "text-muted-foreground", cell: (r) => r.tier },
  ];
}

function TopAgentsTable({ rows }: { rows: AgentActivityRow[] }) {
  return (
    <Card title="Top writers · 30d" subtitle="by archival count">
      <StatTable
        rows={rows}
        rowKey={(r) => r.agent_id}
        empty="No agents wrote archival in the last 30 days."
        columns={[
          ...agentIdentityColumns<AgentActivityRow>(),
          { header: "Writes", cell: (r) => fmt(r.writes_30d) },
          { header: "Types", cell: (r) => r.type_variety },
          { header: "Last", className: "text-muted-foreground", cell: (r) => r.last_write },
        ]}
      />
    </Card>
  );
}

function DormantAgentsTable({ rows }: { rows: DormantAgentRow[] }) {
  return (
    <Card title="Dormant · 0 writes in 30d" subtitle="newest agents first">
      <StatTable
        rows={rows}
        rowKey={(r) => r.agent_id}
        empty="All agents wrote archival in the last 30 days."
        columns={[
          ...agentIdentityColumns<DormantAgentRow>(),
          {
            header: "Last write",
            className: "text-muted-foreground",
            cell: (r) => r.last_write_ever ?? "never",
          },
          {
            header: "Created",
            className: "text-muted-foreground",
            cell: (r) => r.agent_created,
          },
        ]}
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Core snapshot + ratio
// ─────────────────────────────────────────────────────────────────────────

function CoreSnapshotTable({ rows }: { rows: CoreSnapshotRow[] }) {
  return (
    <Card
      title="Core memory · current state"
      subtitle="snapshot proxies (undercount churn)"
    >
      <StatTable
        rows={rows}
        rowKey={(r) => `${r.tier}:${r.block_name}`}
        empty="No core memory blocks exist yet."
        columns={[
          { header: "Tier", align: "left", className: "text-muted-foreground", cell: (r) => r.tier },
          { header: "Block", align: "left", className: "text-foreground", cell: (r) => r.block_name },
          { header: "Blocks", cell: (r) => fmt(r.blocks) },
          { header: "Non-empty", cell: (r) => fmt(r.non_empty) },
          { header: "Ever updated", cell: (r) => fmt(r.ever_updated) },
          { header: "Updated 30d", cell: (r) => fmt(r.updated_30d) },
          { header: "Avg chars", className: "text-muted-foreground", cell: (r) => fmt(r.avg_chars) },
        ]}
      />
    </Card>
  );
}

function RatioTable({ rows }: { rows: AgentRatioRow[] }) {
  return (
    <Card
      title="Archival ÷ core · per agent (30d)"
      subtitle="high ratio = bias toward archival, never touches core"
    >
      <StatTable
        rows={rows}
        rowKey={(r) => r.agent_id}
        empty="No memory writes in the last 30 days."
        columns={[
          ...agentIdentityColumns<AgentRatioRow>("max-w-[200px]"),
          { header: "Archival", cell: (r) => fmt(r.archival_30d) },
          { header: "Core touched", cell: (r) => fmt(r.core_touched_30d) },
          { header: "Ratio", className: "font-semibold", cell: (r) => (r.ratio === null ? "—" : r.ratio) },
        ]}
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Before / after split
// ─────────────────────────────────────────────────────────────────────────

function BeforeAfterPanel({ data }: { data: BeforeAfterData }) {
  return (
    <Card
      title={`Before / after · boundary ${data.since}`}
      subtitle="±14 days each side"
    >
      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Aggregate
          </div>
          <table className="w-full text-xs tabular-nums">
            <tbody>
              {[
                ["Writes", data.agg.writes_pre, data.agg.writes_post],
                ["Active agents", data.agg.agents_pre, data.agg.agents_post],
              ].map(([label, pre, post]) => (
                <tr key={String(label)} className="border-b border-border/20 last:border-0">
                  <td className="py-1.5 text-muted-foreground">{label}</td>
                  <td className="text-right py-1.5">pre {fmt(Number(pre))}</td>
                  <td className="text-right py-1.5">post {fmt(Number(post))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            fact_type mix
          </div>
          <table className="w-full text-xs tabular-nums">
            <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
              <tr className="border-b border-border/40">
                <th className="text-left py-1.5">Type</th>
                <th className="text-right py-1.5">pre</th>
                <th className="text-right py-1.5">post</th>
                <th className="text-right py-1.5">pre %</th>
                <th className="text-right py-1.5">post %</th>
              </tr>
            </thead>
            <tbody>
              {data.by_type.map((r) => (
                <tr key={r.fact_type} className="border-b border-border/20 last:border-0">
                  <td className="py-1.5 text-foreground">{r.fact_type}</td>
                  <td className="text-right py-1.5">{fmt(r.pre)}</td>
                  <td className="text-right py-1.5">{fmt(r.post)}</td>
                  <td className="text-right py-1.5 text-muted-foreground">
                    {r.pre_pct === null ? "—" : `${r.pre_pct}%`}
                  </td>
                  <td className="text-right py-1.5 text-muted-foreground">
                    {r.post_pct === null ? "—" : `${r.post_pct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Card shell + tiny helpers
// ─────────────────────────────────────────────────────────────────────────

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg glass-surface p-5 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {subtitle ? (
          <span className="text-[10px] text-muted-foreground">{subtitle}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs text-muted-foreground py-4 text-center">
      {children}
    </div>
  );
}

/**
 * One column of a {@link StatTable}: its header, how to render a cell, and
 * which way it aligns. `align` defaults to `"right"` because every table on
 * this page is one or two label columns followed by a run of numbers.
 *
 * `className` is merged onto the `<td>` rather than replacing it, so a
 * column can add emphasis (`font-semibold` on a total, `text-muted-foreground`
 * on a de-emphasized timestamp) without restating the padding and alignment.
 */
interface StatColumn<T> {
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right";
  className?: string;
}

/**
 * The metrics table this page draws five times.
 *
 * `ScopeTypeSection`, `TopAgentsTable`, `DormantAgentsTable`,
 * `CoreSnapshotTable` and `RatioTable` had each spelled out the same
 * `<table>` / `<thead>` / `<tbody>` scaffold with the same six utility-class
 * strings — `w-full text-xs`, the `text-[10px] uppercase tracking-wider`
 * head, `border-b border-border/40`, `tabular-nums`, `border-b
 * border-border/20 last:border-0`, `py-1.5`. Only the column list and the
 * empty-state sentence actually differed between them, so those are the two
 * things this takes as props.
 *
 * Rendering `empty` in place of the table (rather than an empty `<tbody>`)
 * preserves what four of the five already did; `ScopeTypeSection` pivots a
 * fixed three-scope matrix and can't be empty, so it passes no `empty`.
 */
function StatTable<T>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: ReadonlyArray<StatColumn<T>>;
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  empty?: React.ReactNode;
}) {
  if (rows.length === 0 && empty !== undefined) return <EmptyHint>{empty}</EmptyHint>;
  return (
    <table className="w-full text-xs">
      <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
        <tr className="border-b border-border/40">
          {columns.map((c, i) => (
            <th key={i} className={c.align === "left" ? "text-left py-1.5" : "text-right py-1.5"}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.map((row, ri) => (
          <tr key={rowKey(row, ri)} className="border-b border-border/20 last:border-0">
            {columns.map((c, ci) => (
              <td
                key={ci}
                className={cn(c.align === "left" ? "py-1.5" : "text-right py-1.5", c.className)}
              >
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The agent-name link three of the tables render identically. */
function AgentLink({ id, name }: { id: string; name: string }) {
  return (
    <Link href={`/agents/${id}`} className="hover:underline">
      {name}
    </Link>
  );
}

function fmt(n: number): string {
  return n.toLocaleString();
}
