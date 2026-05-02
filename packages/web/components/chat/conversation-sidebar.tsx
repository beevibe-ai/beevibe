"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Plus } from "lucide-react";
import { api, type ChatConversationsResponse } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Past conversations list. The chat surface treats each chain (linked by
 * `prior_session_id`) as one conversation. Server returns the head session
 * id + a preview; clicking a row navigates to `/chat?c=<head_id>` which
 * fetches that conversation's messages and chains the next turn from
 * there.
 */
export function ConversationSidebar({
  activeConversationId,
  isFresh,
  onNew,
}: {
  activeConversationId: string | undefined;
  isFresh: boolean;
  onNew: () => void;
}) {
  const conversations = useQuery<ChatConversationsResponse>({
    queryKey: queryKeys.chat.conversations(),
    queryFn: ({ signal }) => api.chat.conversations({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });

  const list = conversations.data?.conversations ?? [];
  // The "no specific c, no new" state == latest conversation, which is
  // conversations[0]. Highlight it so the user sees they're in it.
  const latestId = list[0]?.head_id;
  const effectiveActive = activeConversationId ?? (isFresh ? undefined : latestId);

  return (
    <aside className="w-64 shrink-0 border-r border-border/60 flex flex-col overflow-hidden bg-card/40">
      <div className="px-3 pt-3 pb-2 border-b border-border/60">
        <button
          type="button"
          onClick={onNew}
          disabled={isFresh}
          className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="h-3.5 w-3.5" />
          New conversation
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {conversations.isLoading ? (
          <SidebarSkeleton />
        ) : list.length === 0 ? (
          <SidebarEmpty />
        ) : (
          <ul>
            {list.map((c) => {
              const active = effectiveActive === c.head_id;
              return (
                <li key={c.head_id}>
                  <Link
                    href={`/chat?c=${encodeURIComponent(c.head_id)}`}
                    className={cn(
                      "block px-3 py-2 mx-1 my-0.5 rounded transition-colors",
                      active
                        ? "bg-secondary"
                        : "hover:bg-secondary/60",
                    )}
                  >
                    <div className="flex items-baseline gap-1.5">
                      <div
                        className={cn(
                          "text-xs font-medium truncate flex-1 min-w-0",
                          active ? "text-foreground" : "text-foreground/85",
                        )}
                      >
                        {c.title}
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground/80 shrink-0">
                        {formatRelativeTime(new Date(c.last_at))}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 leading-snug">
                      {c.last_preview}
                    </div>
                    {c.turn_count > 1 ? (
                      <div className="mt-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
                        {c.turn_count} turns
                      </div>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function SidebarSkeleton() {
  return (
    <ul className="px-1 py-0.5 space-y-1">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="px-2 py-2 mx-1 my-0.5 rounded">
          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          <div className="mt-1.5 h-2.5 w-full rounded bg-muted/70 animate-pulse" />
          <div className="mt-1 h-2.5 w-2/3 rounded bg-muted/70 animate-pulse" />
        </li>
      ))}
    </ul>
  );
}

function SidebarEmpty() {
  return (
    <div className="px-4 py-6 text-center text-xs text-muted-foreground">
      <MessageSquare className="h-5 w-5 mx-auto mb-2 text-muted-foreground/50" />
      <div>No conversations yet.</div>
      <div className="mt-0.5 text-muted-foreground/70">Send a message to start one.</div>
    </div>
  );
}
