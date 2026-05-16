"use client";

import { AlertTriangle, Info, TrendingUp, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PromotionEventSkeleton } from "@/components/skeletons";
import { PromotionEventRow } from "@/components/promotions/event-row";
import { usePromotions } from "@/lib/hooks/use-promotions";
import { isApiConfigured } from "@/lib/api/config";
import type { PromotionEvent } from "@/lib/types/promotion-events";

export function PromotionsClient() {
  const { data, isLoading, isError } = usePromotions();

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

        <Body data={data} isLoading={isLoading} isError={isError} />

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

function Body({
  data,
  isLoading,
  isError,
}: {
  data: PromotionEvent[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (!isApiConfigured) {
    return (
      <EmptyWrapper
        icon={TrendingUp}
        title="No promotions yet"
        description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load promotion events."
      />
    );
  }

  if (isError) {
    return <EmptyWrapper icon={AlertTriangle} title="Couldn't load promotions" />;
  }

  if (isLoading) {
    return (
      <div className="pl-8 space-y-3">
        {[0, 1, 2].map((i) => (
          <PromotionEventSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <EmptyWrapper
        icon={TrendingUp}
        title="No promotions yet"
        description="Promotion decisions appear here as agents accumulate facts across sessions."
      />
    );
  }

  return (
    <div className="pl-8 border-l border-border">
      {data.map((event) => (
        <PromotionEventRow key={event.id} event={event} />
      ))}
    </div>
  );
}

function EmptyWrapper(props: { icon: LucideIcon; title: string; description?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border">
      <EmptyState {...props} />
    </div>
  );
}
