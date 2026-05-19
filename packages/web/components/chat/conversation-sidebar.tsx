"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Trash2 } from "lucide-react";
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
const TASK_ID_RE = /\btask_[A-Za-z0-9_-]+\b/g;
const GITHUB_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;

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

function compactTitle(title: string): string {
  const text = title.trim();
  const github = text.match(GITHUB_URL_RE);
  if (github) return `${github[1]}/${github[2]}`;

  if (/^\(?interactive\)?$/i.test(text)) return "Interactive session";
  if (/^reply to task_/i.test(text)) return "Task reply";
  if (/^use task_/i.test(text)) return "Task follow-up";
  if (/^try task_/i.test(text)) return "Task attempt";

  return text
    .replace(TASK_ID_RE, "task")
    .replace(/\s+/g, " ")
    .replace(/\s+([?.!,])/g, "$1");
}

function compactPreview(preview: string): string {
  const text = preview.trim();
  if (!text) return "";

  const github = text.match(GITHUB_URL_RE);
  if (/^CLI exited with code null$/i.test(text)) return "Session ended";
  if (/^Dispatched:\s*task_/i.test(text)) return "Dispatched to an agent";
  if (/^Spawned\s+task_/i.test(text)) return "Spawned an agent task";
  if (/^Task\s+task_.*\bis live\b/i.test(text)) return "Task is live";
  if (/^Unblocked\s+task_/i.test(text)) return "Task unblocked";
  if (github) return text.replace(GITHUB_URL_RE, `${github[1]}/${github[2]}`);

  return text
    .replace(TASK_ID_RE, "task")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
}: {
  activeConversationId: string | undefined;
  isFresh: boolean;
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
    <div className="flex-1 overflow-y-auto py-1 min-h-0">
      {conversations.isLoading ? (
        <SidebarSkeleton />
      ) : list.length === 0 ? (
        <SidebarEmpty />
      ) : (
        <BucketedList list={list} effectiveActive={effectiveActive} />
      )}
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
            <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground/55">
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
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const title = compactTitle(c.title);
  const preview = compactPreview(c.last_preview);
  const deleteMutation = useMutation({
    mutationFn: () => api.chat.deleteConversation(c.head_id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.conversations() });
      // Drop the user back to /chat if they're currently viewing the
      // chain we just deleted — otherwise the URL still references a
      // dead head_id and GET /chat?c=… renders an empty surface.
      if (active) router.replace("/chat");
    },
  });

  const onDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      return;
    }
    deleteMutation.mutate();
  };

  return (
    <li>
      <div
        className={cn(
          "group relative block mx-2 my-0.5 rounded-md transition-colors",
          active
            ? "bg-secondary/70 ring-1 ring-border/70"
            : "hover:bg-secondary/45",
          stale && !active && "opacity-55",
          deleteMutation.isPending && "opacity-50 pointer-events-none",
        )}
      >
        <Link
          href={`/chat?c=${encodeURIComponent(c.head_id)}`}
          className="block px-2.5 py-1.5"
          onClick={() => setConfirming(false)}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "text-[13px] leading-5 truncate flex-1 min-w-0",
                active ? "text-foreground font-medium" : "text-foreground/82",
              )}
            >
              {title}
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground/55 shrink-0 group-hover:invisible">
              {formatRelativeTime(c.last_at)}
            </span>
          </div>
          {preview ? (
            <div
              className={cn(
                "mt-0.5 text-[11px] text-muted-foreground/75 line-clamp-1 leading-snug",
                active ? "block" : "hidden group-hover:block",
              )}
            >
              {preview}
            </div>
          ) : null}
        </Link>
        <button
          type="button"
          onClick={onDeleteClick}
          onBlur={() => setConfirming(false)}
          aria-label={confirming ? "Confirm delete conversation" : "Delete conversation"}
          title={confirming ? "Click again to delete" : "Delete conversation"}
          className={cn(
            "absolute top-1.5 right-2 h-5 px-1.5 inline-flex items-center justify-center rounded transition-opacity cursor-pointer text-[10px] font-medium",
            confirming
              ? "opacity-100 bg-status-failed/15 text-status-failed hover:bg-status-failed/25"
              : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground hover:bg-secondary",
          )}
        >
          {confirming ? "Delete?" : <Trash2 className="h-3 w-3" />}
        </button>
      </div>
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
