import type { TrendDay } from "@/lib/types/dashboard";

export function TrendChart({
  days,
  total,
  changePercent,
}: {
  days: TrendDay[];
  total: number;
  changePercent: number;
}) {
  const w = 700;
  const h = 140;
  const left = 40;
  const baselineY = 120;
  const topY = 40;
  const max = 30;
  const slot = (w - left) / days.length;
  const barW = slot - 30;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Sessions completed · last 7 days
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="text-foreground tabular-nums">{total}</span> total ·{" "}
          <span className="text-status-done">+{changePercent}%</span> vs prior 7d
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-32">
        <line x1={left} y1={baselineY} x2={w} y2={baselineY} stroke="hsl(var(--border))" strokeWidth="1" />
        <line
          x1={left}
          y1={(baselineY + topY) / 2}
          x2={w}
          y2={(baselineY + topY) / 2}
          stroke="hsl(var(--border))"
          strokeWidth="1"
          strokeDasharray="2 4"
          opacity="0.5"
        />
        <line x1={left} y1={topY} x2={w} y2={topY} stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray="2 4" opacity="0.5" />
        <text x={left - 8} y={baselineY + 4} textAnchor="end" fontSize="10" fill="hsl(var(--muted-foreground))" fontFamily="JetBrains Mono">
          0
        </text>
        <text x={left - 8} y={(baselineY + topY) / 2 + 4} textAnchor="end" fontSize="10" fill="hsl(var(--muted-foreground))" fontFamily="JetBrains Mono">
          15
        </text>
        <text x={left - 8} y={topY + 4} textAnchor="end" fontSize="10" fill="hsl(var(--muted-foreground))" fontFamily="JetBrains Mono">
          30
        </text>

        {days.map((d, i) => {
          const x = left + 20 + i * slot;
          const barH = (d.value / max) * (baselineY - topY);
          const y = baselineY - barH;
          const labelY = y - 6;
          const dayLabelX = x + barW / 2;
          return (
            <g key={d.label}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx="2"
                fill={d.is_today ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.3)"}
              />
              <text
                x={dayLabelX}
                y={labelY}
                textAnchor="middle"
                fontSize="10"
                fontFamily="JetBrains Mono"
                fill={d.is_today ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))"}
                fontWeight={d.is_today ? "600" : "400"}
              >
                {d.value}
              </text>
              <text
                x={dayLabelX}
                y={baselineY + 15}
                textAnchor="middle"
                fontSize="11"
                fill={d.is_today ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))"}
                fontWeight={d.is_today ? "600" : "400"}
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
