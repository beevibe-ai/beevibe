import type { Metadata } from "next";
import { Hash, Info } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { ChannelRail } from "@/components/threads/channel-rail";
import { ThreadActionFooter } from "@/components/threads/thread-action-footer";
import { ThreadTimeline } from "@/components/threads/timeline";
import { fixtureActiveChannel } from "@/lib/fixtures/thread-messages";

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
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold truncate">{fixtureActiveChannel.title}</h1>
                <span className="inline-flex items-center gap-1.5 h-5 px-1.5 rounded text-[10px] font-medium bg-status-review/10 text-status-review">
                  <span className="h-1 w-1 rounded-full bg-status-review" />
                  {fixtureActiveChannel.status}
                </span>
                <span className="inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium bg-secondary text-secondary-foreground">
                  {fixtureActiveChannel.priority}
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                <span className="font-mono">{fixtureActiveChannel.task_short_id}</span>
                <span className="text-border">·</span>
                <span>
                  {fixtureActiveChannel.message_count} messages ·{" "}
                  {fixtureActiveChannel.session_count} sessions
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex -space-x-1.5">
              {fixtureActiveChannel.members.map((m, i) => (
                <span
                  key={i}
                  style={{ boxShadow: "0 0 0 2px hsl(var(--background))" }}
                  className="rounded-full"
                >
                  <Avatar initial={m.initial} kind={m.kind} size={22} />
                </span>
              ))}
            </div>
            <button
              className="h-7 w-7 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
              title="Thread details"
              aria-label="Thread details"
            >
              <Info className="h-4 w-4" />
            </button>
          </div>
        </header>

        <ThreadTimeline />
        <ThreadActionFooter />
      </main>
    </div>
  );
}
