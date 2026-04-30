import type { ChainBudgetRow } from "@/lib/types/mesh";

const BAR_COLOR = {
  done: "bg-status-done",
  review: "bg-status-review",
  primary: "bg-primary",
} as const;

const EMPTY_ROW: ChainBudgetRow = {
  used_label: "—",
  max_label: "—",
  percent: 0,
  color: "primary",
};

export function ChainBudget() {
  return (
    <div className="mt-5 rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-baseline justify-between mb-2.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Chain budget · last 24h
        </span>
      </div>
      <div className="space-y-2 text-xs">
        <BudgetRow label="Avg depth" row={EMPTY_ROW} />
        <BudgetRow label="Max depth" row={EMPTY_ROW} />
        <BudgetRow label="Tokens used" row={EMPTY_ROW} />
      </div>
      <div className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
        <span className="text-foreground/80">ChainBudget</span> caps each chain at depth 4 or 50k
        tokens, whichever first.
      </div>
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
