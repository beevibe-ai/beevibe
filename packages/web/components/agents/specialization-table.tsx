import Link from "next/link";
import { ArrowRight, Bot } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export function SpecializationTable() {
  return (
    <div className="max-w-5xl mx-auto mt-10">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Specialization depth · per agent
        </h2>
        <Link
          href="/memory"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        >
          Browse all facts <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Specialization depth populates as agents accumulate sessions and learned facts."
        />
      </div>
      <p className="mt-2.5 text-[10px] text-muted-foreground">
        Each agent&rsquo;s depth is bounded — no agent&rsquo;s facts dilute another&rsquo;s. Promoted
        facts (visible to wider scopes) preserve their originating agent_id.
      </p>
    </div>
  );
}
