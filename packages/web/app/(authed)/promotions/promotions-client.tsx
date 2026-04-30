"use client";

import { AlertTriangle, Info, TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { MemorySubNav } from "@/components/memory/sub-nav";
import { PromotionEventRow } from "@/components/promotions/event-row";
import { usePromotions } from "@/lib/hooks/use-promotions";
import { isApiConfigured } from "@/lib/api/config";

export function PromotionsClient() {
  const { data, isLoading, isError } = usePromotions();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-12 px-6">
        <MemorySubNav />

        <div className="mb-6 flex items-baseline justify-between gap-6">
          <div>
            <h1 className="text-base font-semibold mb-1">Promotions</h1>
            <p className="text-sm text-muted-foreground max-w-prose leading-relaxed">
              When the same observation reappears across sessions,{" "}
              <span className="font-mono text-foreground">FactPromoter</span> evaluates whether it has
              earned a wider scope. Each event below is the LLM&rsquo;s per-fact decision with its stated
              reason. The default is to keep facts narrow.
            </p>
          </div>
        </div>

        {!isApiConfigured ? (
          <div className="rounded-lg border border-dashed border-border">
            <EmptyState
              icon={TrendingUp}
              title="No promotions yet"
              description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load promotion events."
            />
          </div>
        ) : isError ? (
          <div className="rounded-lg border border-dashed border-border">
            <EmptyState icon={AlertTriangle} title="Couldn't load promotions" />
          </div>
        ) : isLoading ? (
          <div className="pl-8 space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 rounded" />
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border">
            <EmptyState
              icon={TrendingUp}
              title="No promotions yet"
              description="Promotion decisions appear here as agents accumulate facts across sessions."
            />
          </div>
        ) : (
          <div className="pl-8 border-l border-border">
            {data.map((event) => (
              <PromotionEventRow key={event.id} event={event} />
            ))}
          </div>
        )}

        <div className="mt-10 text-xs text-muted-foreground flex items-start gap-2 max-w-2xl">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <span className="text-foreground/80">No flat pool exists.</span> Every fact, at every
            scope, is attributed to its originating agent (
            <span className="font-mono">memory_fact.agent_id</span> is non-null). Promotion changes{" "}
            <em>visibility radius</em>, not authorship.
          </span>
        </div>
      </div>
    </div>
  );
}
