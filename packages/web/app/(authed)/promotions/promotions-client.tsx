"use client";

import { Info, TrendingUp } from "lucide-react";
import { PromotionEventSkeleton } from "@/components/skeletons";
import { ListGate } from "@/components/list-gate";
import { PromotionEventRow } from "@/components/promotions/event-row";
import { usePromotions } from "@/lib/hooks/use-promotions";

export function PromotionsClient() {
  const query = usePromotions();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-12 px-6">
        <div className="mb-6 flex items-baseline justify-between gap-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight mb-1">Promotions</h1>
            <p className="text-sm text-muted-foreground max-w-prose leading-relaxed">
              When the same observation reappears across sessions,{" "}
              <span className="font-mono text-foreground">FactPromoter</span> evaluates whether it has
              earned a wider scope. Each event below is the LLM&rsquo;s per-fact decision with its stated
              reason. The default is to keep facts narrow.
            </p>
          </div>
        </div>

        <ListGate
          query={query}
          noun="promotion events"
          icon={TrendingUp}
          empty={{
            title: "No promotions yet",
            description:
              "Promotion decisions appear here as agents accumulate facts across sessions.",
          }}
          skeleton={
            <div className="pl-8 space-y-3">
              {[0, 1, 2].map((i) => (
                <PromotionEventSkeleton key={i} />
              ))}
            </div>
          }
        >
          {(events) => (
            <div className="pl-8 border-l border-border">
              {events.map((event) => (
                <PromotionEventRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </ListGate>

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

