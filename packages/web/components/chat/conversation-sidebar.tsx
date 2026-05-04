"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Plus } from "lucide-react";
import {
  api,
  type ChatConversationsResponse,
  type ChatConversationSummary,
} from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Bucket = "today" | "yesterday" | "this_week" | "older";

const BUCKET_LABELS: Record<Bucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  older: "Older",
};

const BUCKET_ORDER: readonly Bucket[] = ["today", "yesterday", "this_week", "older"];

const DAY_MS = 24 * 60 * 60 * 1000;

function bucketOf(iso: string, now: number): Bucket {
  const t = new Date(iso).getTime();
  const today = new Date(now);
  const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (t >= today0) return "today";
  if (t >= today0 - DAY_MS) return "yesterday";
  if (t >= today0 - 7 * DAY_MS) return "this_week";
  return "older";
}

function bucketize(list: readonly ChatConversationSummary[]): Record<Bucket, ChatConversationSummary[]> {
  const now = Date.now();
  const out: Record<Bucket, ChatConversationSummary[]> = {
    today: [],
    yesterday: [],
    this_week: [],
    older: [],
  };
  for (const c of list) out[bucketOf(c.last_at, now)].push(c);
  return out;
}

/**
 * Past conversations list, embedded inside the main app sidebar when on
 * /chat (Notion-style: one rail morphs by route, two rails would be
 * noise). The chat surface treats each chain (linked by
 * `prior_session_id`) as one conversation. Server returns the head session
 * id + a preview; clicking a row navigates to `/chat?c=<head_id>` which
 * fetches that conversation's messages and chains the next turn from
 * there.
 *
 * No outer aside / border / background — the parent sidebar owns chrome.
 * This component just renders the New-conversation button + the bucketed
 * list inside whatever container it's slotted into.
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
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-2 pt-1 pb-2">
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
          <BucketedList list={list} effectiveActive={effectiveActive} />
        )}
      </div>
    </div>
  );
}

function BucketedList({
  list,
  effectiveActive,
}: {
  list: readonly ChatConversationSummary[];
  effectiveActive: string | undefined;
}) {
  const buckets = bucketize(list);
  return (
    <div>
      {BUCKET_ORDER.map((bucket) => {
        const items = buckets[bucket];
        if (items.length === 0) return null;
        // Older items fade — visual ladder so the user's eye lands on
        // recent activity first. The bucket itself is the time signal;
        // fading reinforces it without adding chrome.
        const stale = bucket === "older";
        return (
          <section key={bucket} className="mb-1.5 last:mb-0">
            <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">
              {BUCKET_LABELS[bucket]}
            </div>
            <ul>
              {items.map((c) => (
                <ConversationRow
                  key={c.head_id}
                  c={c}
                  active={effectiveActive === c.head_id}
                  stale={stale}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ConversationRow({
  c,
  active,
  stale,
}: {
  c: ChatConversationSummary;
  active: boolean;
  stale: boolean;
}) {
  return (
    <li>
      <Link
        href={`/chat?c=${encodeURIComponent(c.head_id)}`}
        className={cn(
          "block px-3 py-1.5 mx-1 my-0.5 rounded transition-colors",
          active ? "bg-secondary" : "hover:bg-secondary/60",
          stale && !active && "opacity-60",
        )}
      >
        <div className="flex items-baseline gap-1.5">
          <div
            className={cn(
              "text-xs truncate flex-1 min-w-0",
              active ? "text-foreground font-semibold" : "text-foreground/85 font-medium",
            )}
          >
            {c.title}
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
            {formatRelativeTime(c.last_at)}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground line-clamp-1 leading-snug">
          {c.last_preview}
        </div>
      </Link>
    </li>
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
