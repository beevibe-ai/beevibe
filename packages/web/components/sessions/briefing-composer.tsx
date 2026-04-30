"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Layers, Search, SquareStack } from "lucide-react";
import { ScopeChip } from "@/components/scope-chip";
import { cn } from "@/lib/utils";
import type { SessionDisplay } from "@/lib/types/sessions";

export function BriefingComposer({ briefing }: { briefing: SessionDisplay["briefing"] }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden mb-5">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="briefing-composer-body"
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/40 transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2.5">
          <Layers className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Briefing</span>
          <span className="text-xs text-muted-foreground">
            — what this session was told before it started
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">
            {briefing.block_count} blocks · {briefing.fact_count} facts ·{" "}
            {briefing.token_count.toLocaleString()} tokens
          </span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>

      {open ? (
        <div id="briefing-composer-body" className="border-t border-border p-4 space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2 text-xs">
              <SquareStack className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium text-foreground">Core memory blocks</span>
              <span className="text-muted-foreground">
                — bounded persona/domain/constraints, agent-edited
              </span>
            </div>
            <div className="space-y-1.5 ml-5 text-xs">
              {briefing.blocks.map((b) => (
                <div key={b.name} className="flex items-center gap-2 text-muted-foreground">
                  <span className="font-mono text-foreground">{b.name}</span>
                  <span className="text-border">·</span>
                  <span className="tabular-nums">{b.chars.toLocaleString()} chars</span>
                  <span className="text-foreground/70 italic truncate">&ldquo;{b.preview}&rdquo;</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2 text-xs">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium text-foreground">Retrieved facts</span>
              <span className="text-muted-foreground">
                — top-{briefing.facts.length} by cosine similarity to task intent · scope ≤ ic
              </span>
            </div>
            <div className="space-y-2 ml-5">
              {briefing.facts.map((f, i) => (
                <div key={i} className="text-xs flex items-start gap-2">
                  <ScopeChip scope={f.scope} className={cn("h-4 px-1.5 shrink-0 mt-0.5")} />
                  <span className="text-foreground/85 leading-relaxed flex-1">{f.content}</span>
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    {f.score.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
