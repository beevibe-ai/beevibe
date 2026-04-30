"use client";

import { AlertTriangle, Hash, MessageSquare } from "lucide-react";
import { ChannelRail } from "@/components/threads/channel-rail";
import { ThreadActionFooter } from "@/components/threads/thread-action-footer";
import { ThreadTimeline } from "@/components/threads/timeline";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { useThreads } from "@/lib/hooks/use-threads";
import { isApiConfigured } from "@/lib/api/config";
import type { ThreadsOverview } from "@/lib/api/types";
import type { ThreadChannel } from "@/lib/types/thread-messages";

export function ThreadsClient() {
  const { data, isLoading, isError } = useThreads();

  return (
    <div className="flex-1 min-w-0 flex">
      <Rail data={data} isLoading={isLoading} isError={isError} />

      <main className="flex-1 min-w-0 flex flex-col bg-background overflow-hidden">
        <header className="px-6 py-3 flex items-center justify-between gap-4 shrink-0 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-semibold">
                {data?.active_channel?.title ?? "Select a thread"}
              </h1>
              <div className="text-xs text-muted-foreground mt-0.5">
                {data?.active_channel?.task_short_id ?? "Pick a channel from the rail or create a new task."}
              </div>
            </div>
          </div>
        </header>

        <Body data={data} isLoading={isLoading} isError={isError} />
        {data?.active_channel ? <ThreadActionFooter /> : null}
      </main>
    </div>
  );
}

function Rail({
  data,
  isLoading,
  isError,
}: {
  data: ThreadsOverview | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (!isApiConfigured || isError || isLoading || !data || data.channels.length === 0) {
    return <ChannelRail />;
  }

  return (
    <aside className="w-[280px] shrink-0 bg-secondary/30 flex flex-col overflow-hidden border-r border-border">
      <div className="px-4 pt-5 pb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Threads</h2>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-150 cursor-pointer"
        >
          + New task
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-4">
        <ChannelGroup label="Channels" channels={data.channels} />
      </div>
    </aside>
  );
}

function ChannelGroup({ label, channels }: { label: string; channels: ThreadChannel[] }) {
  return (
    <div>
      <div className="px-2 mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">
        {label}{" "}
        <span className="text-muted-foreground/50 tabular-nums">{channels.length}</span>
      </div>
      <ul className="space-y-0.5">
        {channels.map((ch) => (
          <li key={ch.id}>
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-secondary transition-colors text-sm cursor-pointer"
            >
              <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 min-w-0 truncate text-left">{ch.title}</span>
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{ch.age}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
}: {
  data: ThreadsOverview | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (!isApiConfigured) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto">
          <EmptyState
            icon={MessageSquare}
            title="No messages yet"
            description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load thread activity."
          />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto">
          <EmptyState icon={AlertTriangle} title="Couldn't load threads" />
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return <ThreadTimeline />;
}
