interface MetricsProps {
  sessions: number;
  sessions_change: number;
  facts: number;
  merges: number;
  promoted: number;
}

export function DepthMetrics({ sessions, sessions_change, facts, merges, promoted }: MetricsProps) {
  return (
    <div className="grid grid-cols-4 gap-x-8 mt-6 pt-6 border-t border-border">
      <Metric label="Sessions" value={sessions} suffix={`+${sessions_change} this week`} suffixColor="text-status-done" />
      <Metric label="Facts learned" value={facts} suffix="in memory" />
      <Metric label="Merge events" value={merges} suffix="consolidated" />
      <Metric label="Promoted up" value={promoted} suffix="to team / org" />
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
  suffixColor = "text-muted-foreground",
}: {
  label: string;
  value: number;
  suffix: string;
  suffixColor?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums leading-none">{value}</span>
        <span className={`text-xs ${suffixColor}`}>{suffix}</span>
      </div>
    </div>
  );
}
