import type { Metadata } from "next";
import { Hash } from "lucide-react";
import { ChannelRail } from "@/components/threads/channel-rail";
import { ThreadActionFooter } from "@/components/threads/thread-action-footer";
import { ThreadTimeline } from "@/components/threads/timeline";

export const metadata: Metadata = { title: "Threads" };

export default function ThreadsPage() {
  return (
    <div className="flex-1 min-w-0 flex">
      <ChannelRail />

      <main className="flex-1 min-w-0 flex flex-col bg-background overflow-hidden">
        <header className="px-6 py-3 flex items-center justify-between gap-4 shrink-0 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-semibold">Select a thread</h1>
              <div className="text-xs text-muted-foreground mt-0.5">
                Pick a channel from the rail or create a new task.
              </div>
            </div>
          </div>
        </header>

        <ThreadTimeline />
        <ThreadActionFooter />
      </main>
    </div>
  );
}
