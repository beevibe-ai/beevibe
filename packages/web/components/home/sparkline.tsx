import { cn } from "@/lib/utils";

const COLOR_CLASS = {
  running: "text-status-running",
  review: "text-status-review",
  primary: "text-primary",
  done: "text-status-done",
} as const;

type Color = keyof typeof COLOR_CLASS;

export function LineSparkline({ values, color }: { values: number[]; color: Color }) {
  const w = 120;
  const h = 24;
  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);
  const linePoints = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${(h - (v / max) * (h - 4)).toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePoints} L${w} ${h} L0 ${h} Z`;
  const last = values[values.length - 1];
  const lastY = h - (last / max) * (h - 4);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("mt-2 w-full h-6", COLOR_CLASS[color])}>
      <path d={areaPath} fill="currentColor" fillOpacity="0.12" />
      <path d={linePoints} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={w} cy={lastY.toFixed(1)} r="2.25" fill="currentColor" />
    </svg>
  );
}

export function BarSparkline({
  values,
  color,
  opacities,
}: {
  values: number[];
  color: Color;
  opacities?: number[];
}) {
  const w = 120;
  const h = 24;
  const max = Math.max(...values, 1);
  const slot = w / values.length;
  const barW = slot - 4;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("mt-2 w-full h-6", COLOR_CLASS[color])}>
      {values.map((v, i) => {
        const barH = (v / max) * (h - 4);
        const opacity =
          opacities && opacities[i] !== undefined
            ? opacities[i]
            : i === values.length - 1
              ? 1
              : 0.3 + (v / max) * 0.2;
        return (
          <rect
            key={i}
            x={(i * slot + 2).toFixed(1)}
            y={(h - barH).toFixed(1)}
            width={barW.toFixed(1)}
            height={barH.toFixed(1)}
            rx="1"
            fill="currentColor"
            opacity={opacity.toFixed(2)}
          />
        );
      })}
    </svg>
  );
}
