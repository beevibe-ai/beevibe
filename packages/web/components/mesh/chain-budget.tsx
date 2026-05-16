import type { ChainBudgetData, ChainBudgetRow } from "@/lib/types/mesh";

const BAR_COLOR = {
  done: "bg-status-done",
  review: "bg-status-review",
  primary: "bg-primary",
} as const;

interface Props {
  /** When undefined the component renders an explicit "no chains yet" empty
   *  state instead of three placeholder dashes (which read as broken UI). */
  data?: ChainBudgetData;
}

export function ChainBudget({ data }: Props = {}) {
  const empty = !data;
  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-baseline justify-between mb-2.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Chain budget · last 24h
        </span>
        {empty ? (
          <span className="text-[10px] text-muted-foreground/70">no chains yet</span>
        ) : null}
      </div>
      {empty ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Depth and token totals appear once an ask spawns a follow-up chain. Each chain is capped
          at depth 4 or 50k tokens, whichever comes first.
        </p>
      ) : (
        <>
          <div className="space-y-2 text-xs">
            <BudgetRow label="Avg depth" row={data.avg_depth} />
            <BudgetRow label="Max depth" row={data.max_depth} />
            <BudgetRow label="Tokens used" row={data.tokens} />
          </div>
          <div className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
            Each chain is capped at depth 4 or 50k tokens, whichever comes first.
          </div>
        </>
      )}
    </div>
  );
}

function BudgetRow({ label, row }: { label: string; row: ChainBudgetRow }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full ${BAR_COLOR[row.color]}`} style={{ width: `${row.percent}%` }} />
      </div>
      <span className="font-mono tabular-nums text-foreground w-12 text-right">
        {row.used_label} / {row.max_label}
      </span>
    </div>
  );
}
