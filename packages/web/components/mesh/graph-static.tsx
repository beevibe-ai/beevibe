import { Network } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export function MeshGraphStatic() {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Live graph · last 24h
        </h2>
        <div className="text-[10px] text-muted-foreground">
          <span className="text-foreground tabular-nums">0</span> edges
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="h-[480px] flex items-center justify-center">
          <EmptyState
            icon={Network}
            title="No mesh activity"
            description="The graph populates as agents ask each other for help."
          />
        </div>
      </div>
    </section>
  );
}
