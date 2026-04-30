export function Metric({
  label,
  value,
  suffix,
  suffixColor = "text-muted-foreground",
}: {
  label: string;
  value: number;
  suffix?: string;
  suffixColor?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums leading-none">
          {value.toLocaleString()}
        </span>
        {suffix ? <span className={`text-xs ${suffixColor}`}>{suffix}</span> : null}
      </div>
    </div>
  );
}
