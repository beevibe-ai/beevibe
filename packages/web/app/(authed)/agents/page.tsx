import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { OrgChart } from "@/components/agents/org-chart";
import { SpecializationTable } from "@/components/agents/specialization-table";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="pt-8 pb-12 px-6">
        <div className="max-w-5xl mx-auto flex items-end justify-between gap-6 mb-8">
          <div className="text-base text-muted-foreground">
            <span className="text-foreground font-medium">No agents</span> in your org yet.
          </div>
          <button className="inline-flex items-center gap-2 h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-150 cursor-pointer shrink-0">
            <Plus className="h-3.5 w-3.5" />
            New agent
          </button>
        </div>

        <div className="max-w-5xl mx-auto">
          <OrgChart />
          <SpecializationTable />
        </div>
      </div>
    </div>
  );
}
