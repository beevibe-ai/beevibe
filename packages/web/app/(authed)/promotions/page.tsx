import type { Metadata } from "next";
import { ArrowRight, ArrowUpDown, Info } from "lucide-react";
import { LoadOlderButton } from "@/components/load-older-button";
import { MemorySubNav } from "@/components/memory/sub-nav";
import { PromotionEventRow } from "@/components/promotions/event-row";
import { ScopeChip } from "@/components/scope-chip";
import { fixturePromotions } from "@/lib/fixtures/promotion-events";

export const metadata: Metadata = { title: "Promotions" };

export default function PromotionsPage() {
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
          <div className="text-xs text-muted-foreground shrink-0 text-right">
            <div>
              <span className="text-foreground tabular-nums">14</span> promotions · last 30d
            </div>
            <div className="mt-1">
              <span className="text-status-done tabular-nums">+3</span> this week
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-4 text-xs">
          <span className="text-muted-foreground">Filter:</span>
          <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded bg-secondary text-foreground font-medium">
            <span>All</span>
            <span className="font-mono tabular-nums text-muted-foreground">14</span>
          </button>
          <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <ScopeChip scope="ic" />
            <ArrowRight className="h-3 w-3" />
            <ScopeChip scope="team" />
            <span className="font-mono tabular-nums">11</span>
          </button>
          <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <ScopeChip scope="team" />
            <ArrowRight className="h-3 w-3" />
            <ScopeChip scope="org" />
            <span className="font-mono tabular-nums">3</span>
          </button>
          <span className="ml-auto text-muted-foreground inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors">
            <ArrowUpDown className="h-3 w-3" />
            <span>Newest</span>
          </span>
        </div>

        <div className="timeline-rail pl-7">
          {fixturePromotions.map((event) => (
            <PromotionEventRow key={event.id} event={event} />
          ))}
        </div>

        <LoadOlderButton label="Load 7 older promotions" />

        <div className="mt-10 text-xs text-muted-foreground flex items-start gap-2 max-w-2xl">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <span className="text-foreground/80">No flat pool exists.</span> Every fact, at every
            scope, is attributed to its originating agent (
            <span className="font-mono">memory_fact.agent_id</span> is non-null). Promotion changes{" "}
            <em>visibility radius</em>, not authorship. The org agent reads org-scope facts at
            brief-time and can override the synthesized view via its own core memory.
          </span>
        </div>
      </div>
    </div>
  );
}
