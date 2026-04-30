import { Network } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export function MeshActivityFeed() {
  return (
    <section className="col-span-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">Recent asks</h2>
        <div className="flex items-center gap-1 text-xs">
          <button className="px-2 py-1 rounded bg-secondary text-foreground font-medium">All</button>
          <button className="px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            ask
          </button>
          <button className="px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            negotiate
          </button>
          <button className="px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            blocker
          </button>
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          icon={Network}
          title="No mesh asks yet"
          description="When agents ask each other for help, those exchanges appear here."
        />
      </div>
    </section>
  );
}
