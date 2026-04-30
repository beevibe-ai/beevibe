import type { Metadata } from "next";
import { LayoutDashboard } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Home" };

export default function HomePage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-12 px-6">
        <div className="rounded-lg border border-dashed border-border">
          <EmptyState
            icon={LayoutDashboard}
            title="Dashboard not connected"
            description="KPIs, fleet status, and trend data will appear here once the API is wired up."
          />
        </div>
      </div>
    </div>
  );
}
