"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, BarChart3 } from "lucide-react";
import { useMemoryActivity } from "@/lib/hooks/use-memory-activity";
import { isApiConfigured } from "@/lib/api/config";
import { BackLink } from "@/components/detail/back-link";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { DatePicker, todayIso } from "@/components/date-picker";
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
        <BackLink href="/memory" label="Memory" />
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
  return (
    <Card title="Archival writes · scope × fact_type">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
          <tr className="border-b border-border/40">
            <th className="text-left py-1.5">Scope</th>
            {FACT_TYPES.map((ft) => (
              <th key={ft} className="text-right py-1.5">
                {ft}
              </th>
            ))}
            <th className="text-right py-1.5">Total</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {scopes.map((scope) => {
            const row = byScope[scope] ?? {};
            const total = Object.values(row).reduce((a, b) => a + b, 0);
            return (
              <tr key={scope} className="border-b border-border/20 last:border-0">
                <td className="py-1.5 text-foreground">{scope}</td>
                {FACT_TYPES.map((ft) => (
                  <td key={ft} className="text-right py-1.5">
                    {row[ft] ? fmt(row[ft]!) : "—"}
                  </td>
                ))}
                <td className="text-right py-1.5 font-semibold">
                  {total ? fmt(total) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Top + dormant agents
// ─────────────────────────────────────────────────────────────────────────

function TopAgentsTable({ rows }: { rows: AgentActivityRow[] }) {
  return (
    <Card title="Top writers · 30d" subtitle="by archival count">
      {rows.length === 0 ? (
        <EmptyHint>No agents wrote archival in the last 30 days.</EmptyHint>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr className="border-b border-border/40">
              <th className="text-left py-1.5">Agent</th>
              <th className="text-left py-1.5">Tier</th>
              <th className="text-right py-1.5">Writes</th>
              <th className="text-right py-1.5">Types</th>
              <th className="text-right py-1.5">Last</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.agent_id} className="border-b border-border/20 last:border-0">
                <td className="py-1.5 text-foreground truncate max-w-[160px]">
                  <Link
                    href={`/agents/${r.agent_id}`}
                    className="hover:underline"
                  >
                    {r.name}
                  </Link>
                </td>
                <td className="py-1.5 text-muted-foreground">{r.tier}</td>
                <td className="text-right py-1.5">{fmt(r.writes_30d)}</td>
                <td className="text-right py-1.5">{r.type_variety}</td>
                <td className="text-right py-1.5 text-muted-foreground">{r.last_write}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function DormantAgentsTable({ rows }: { rows: DormantAgentRow[] }) {
  return (
    <Card title="Dormant · 0 writes in 30d" subtitle="newest agents first">
      {rows.length === 0 ? (
        <EmptyHint>All agents wrote archival in the last 30 days.</EmptyHint>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr className="border-b border-border/40">
              <th className="text-left py-1.5">Agent</th>
              <th className="text-left py-1.5">Tier</th>
              <th className="text-right py-1.5">Last write</th>
              <th className="text-right py-1.5">Created</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.agent_id} className="border-b border-border/20 last:border-0">
                <td className="py-1.5 text-foreground truncate max-w-[160px]">
                  <Link
                    href={`/agents/${r.agent_id}`}
                    className="hover:underline"
                  >
                    {r.name}
                  </Link>
                </td>
                <td className="py-1.5 text-muted-foreground">{r.tier}</td>
                <td className="text-right py-1.5 text-muted-foreground">
                  {r.last_write_ever ?? "never"}
                </td>
                <td className="text-right py-1.5 text-muted-foreground">{r.agent_created}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
      {rows.length === 0 ? (
        <EmptyHint>No core memory blocks exist yet.</EmptyHint>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr className="border-b border-border/40">
              <th className="text-left py-1.5">Tier</th>
              <th className="text-left py-1.5">Block</th>
              <th className="text-right py-1.5">Blocks</th>
              <th className="text-right py-1.5">Non-empty</th>
              <th className="text-right py-1.5">Ever updated</th>
              <th className="text-right py-1.5">Updated 30d</th>
              <th className="text-right py-1.5">Avg chars</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr
                key={`${r.tier}:${r.block_name}`}
                className="border-b border-border/20 last:border-0"
              >
                <td className="py-1.5 text-muted-foreground">{r.tier}</td>
                <td className="py-1.5 text-foreground">{r.block_name}</td>
                <td className="text-right py-1.5">{fmt(r.blocks)}</td>
                <td className="text-right py-1.5">{fmt(r.non_empty)}</td>
                <td className="text-right py-1.5">{fmt(r.ever_updated)}</td>
                <td className="text-right py-1.5">{fmt(r.updated_30d)}</td>
                <td className="text-right py-1.5 text-muted-foreground">
                  {fmt(r.avg_chars)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function RatioTable({ rows }: { rows: AgentRatioRow[] }) {
  return (
    <Card
      title="Archival ÷ core · per agent (30d)"
      subtitle="high ratio = bias toward archival, never touches core"
    >
      {rows.length === 0 ? (
        <EmptyHint>No memory writes in the last 30 days.</EmptyHint>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr className="border-b border-border/40">
              <th className="text-left py-1.5">Agent</th>
              <th className="text-left py-1.5">Tier</th>
              <th className="text-right py-1.5">Archival</th>
              <th className="text-right py-1.5">Core touched</th>
              <th className="text-right py-1.5">Ratio</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.agent_id} className="border-b border-border/20 last:border-0">
                <td className="py-1.5 text-foreground truncate max-w-[200px]">
                  <Link href={`/agents/${r.agent_id}`} className="hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className="py-1.5 text-muted-foreground">{r.tier}</td>
                <td className="text-right py-1.5">{fmt(r.archival_30d)}</td>
                <td className="text-right py-1.5">{fmt(r.core_touched_30d)}</td>
                <td className="text-right py-1.5 font-semibold">
                  {r.ratio === null ? "—" : r.ratio}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

function fmt(n: number): string {
  return n.toLocaleString();
}
