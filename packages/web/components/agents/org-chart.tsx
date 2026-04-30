import { UsersRound } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export function OrgChart() {
  return (
    <div className="rounded-lg border border-dashed border-border">
      <EmptyState
        icon={UsersRound}
        title="No agents yet"
        description="Create your first agent to see your org chart."
      />
    </div>
  );
}
