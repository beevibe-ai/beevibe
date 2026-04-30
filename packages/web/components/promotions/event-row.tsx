import Link from "next/link";
import { ArrowRight, BrainCircuit, Hash, TrendingUp, X } from "lucide-react";
import { ScopeChip } from "@/components/scope-chip";
import { formatRelativeTime, sessionHref } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PromotionEvent } from "@/lib/types/promotion-events";

const DOT_BORDER_CLASS = {
  ic: "border-hier-ic",
  team: "border-hier-team",
  org: "border-hier-org",
} as const;

const DOT_TEXT_CLASS = {
  ic: "text-hier-ic",
  team: "text-hier-team",
  org: "text-hier-org",
} as const;

export function PromotionEventRow({ event }: { event: PromotionEvent }) {
  const dotBorder = event.rejected ? "border-border" : DOT_BORDER_CLASS[event.to_scope];
  const dotIconColor = event.rejected ? "text-muted-foreground" : DOT_TEXT_CLASS[event.to_scope];

  return (
    <div
      className={cn(
        "relative py-4 border-b border-border",
        event.rejected && "opacity-70",
      )}
    >
      <div
        className={cn(
          "timeline-dot absolute -left-7 top-5 h-6 w-6 rounded-full bg-background border-2 flex items-center justify-center",
          dotBorder,
        )}
      >
        {event.rejected ? (
          <X className={cn("h-3 w-3", dotIconColor)} />
        ) : (
          <TrendingUp className={cn("h-3 w-3", dotIconColor)} />
        )}
      </div>
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex items-center gap-2 text-xs">
          {event.rejected ? (
            <>
              {event.from_scope ? <ScopeChip scope={event.from_scope} className="h-5 px-1.5" /> : null}
              <span className="text-border">·</span>
              <span className="text-muted-foreground italic">candidate rejected — kept narrow</span>
              <span className="text-border">·</span>
              <span className="text-muted-foreground">
                in{" "}
                <Link href="#" className="font-mono text-foreground hover:underline">
                  {event.origin_agent_label}
                </Link>
              </span>
            </>
          ) : (
            <>
              {event.from_scope ? <ScopeChip scope={event.from_scope} className="h-5 px-1.5" /> : null}
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <ScopeChip scope={event.to_scope} className="h-5 px-1.5" />
              <span className="text-border">·</span>
              <span className="text-muted-foreground">
                originated by{" "}
                <Link href="#" className="font-mono text-foreground hover:underline">
                  {event.origin_agent_label}
                </Link>
              </span>
            </>
          )}
        </div>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          {formatRelativeTime(event.created_at)}
        </span>
      </div>
      <p className="text-sm leading-relaxed mb-2">{event.fact_content}</p>
      <div className="rounded-lg bg-secondary/50 p-3 mb-2">
        <div className="flex items-start gap-2 text-xs">
          <BrainCircuit
            className={cn("h-3.5 w-3.5 shrink-0 mt-0.5", event.rejected ? "text-muted-foreground" : "text-primary")}
          />
          <div className="text-muted-foreground leading-relaxed">
            <span className="text-foreground font-medium">FactPromoter:</span>{" "}
            &ldquo;{event.promoter_reason}&rdquo;
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
        <span className="inline-flex items-center gap-1">
          <Hash className="h-3 w-3" />
          {event.fact_id}
        </span>
        <span className="text-border">·</span>
        <span>source sessions:</span>
        {event.source_session_ids.map((sid) => (
          <Link key={sid} href={sessionHref(sid)} className="hover:text-foreground transition-colors">
            {sid}
          </Link>
        ))}
        {event.source_session_extra ? (
          <span className="text-muted-foreground/60">+{event.source_session_extra} more</span>
        ) : null}
      </div>
    </div>
  );
}
