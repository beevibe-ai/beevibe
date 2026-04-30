import { MessageSquare } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export function ThreadTimeline() {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="max-w-3xl mx-auto">
        <EmptyState
          icon={MessageSquare}
          title="No messages yet"
          description="Thread activity appears here as agents work, raise blockers, and reply."
        />
      </div>
    </div>
  );
}
