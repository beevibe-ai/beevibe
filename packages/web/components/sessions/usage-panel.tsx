import { CircleDollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cacheHitTone,
  formatCacheHit,
  formatCost,
  formatTokens,
  statusToneClass,
  type StatusTone,
} from "@/lib/usage-format";
import type { SessionUsageDisplay } from "@/lib/types/sessions";

/**
 * Per-session cost + token usage panel. Tiered visual hierarchy:
 * headline cost + cache-hit ratio (the two numbers a reviewer needs),
 * mid-tier token breakdown, muted model name.
 */
export function UsagePanel({ usage }: { usage: SessionUsageDisplay }) {
  return (
    <section
      className="mt-8 pt-5 border-t border-border/60"
      aria-label="Session usage"
    >
      <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4 flex items-center gap-1.5">
        <CircleDollarSign className="h-3 w-3" />
        Usage
      </h2>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <Headline label="cost" value={formatCost(usage.cost_usd)} />
        <Headline
          label="cache hit"
          value={formatCacheHit(usage)}
          tone={cacheHitTone(usage)}
        />
      </div>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-xs border-t border-border/40 pt-3">
        <TokenStat label="Input" value={usage.input_tokens} />
        <TokenStat label="Output" value={usage.output_tokens} />
        <TokenStat label="Cache write" value={usage.cache_creation_tokens} />
        <TokenStat label="Cache read" value={usage.cache_read_tokens} />
      </dl>

      <div className="mt-3 text-[11px] text-muted-foreground/60 font-mono">
        {usage.model}
      </div>
    </section>
  );
}

function Headline({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: StatusTone;
}) {
  return (
    <div>
      <div
        className={cn(
          "text-2xl font-semibold tabular-nums",
          tone ? statusToneClass(tone) : "text-foreground",
        )}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground/85 tabular-nums font-mono">
        {formatTokens(value)}
      </dd>
    </div>
  );
}
