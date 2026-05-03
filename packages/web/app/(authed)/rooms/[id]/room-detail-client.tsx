"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  Loader2,
  Send,
  Sparkles,
  UserPlus,
  Users,
} from "lucide-react";
import { useMe } from "@/lib/hooks/use-me";
import { isApiConfigured } from "@/lib/api/config";
import { api, type RoomDetail, type RoomMemberDetail, type RoomMessage } from "@/lib/api/client";
import { ApiError, describeError } from "@/lib/api/http";
import { queryKeys } from "@/lib/hooks/keys";
import { ChatMarkdown } from "@/components/chat/markdown";
import { LivePanel } from "@/components/chat/live-panel";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { formatRelativeTime, sessionHref, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

export function RoomDetailClient({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const { data, isLoading, isError } = useQuery<RoomDetail>({
    queryKey: queryKeys.rooms.detail(roomId),
    queryFn: ({ signal }) => api.rooms.get(roomId, { signal }),
    enabled: isApiConfigured && !!roomId,
    staleTime: 5_000,
  });

  // Optimistic UI: snapshot the message text on send, push it into
  // the cached room detail so the sender sees their own line
  // immediately. Real version arrives via SSE invalidation. We
  // dedupe by content + sender on the merge so the optimistic line
  // gets replaced by the persisted one without flickering.
  const send = useMutation({
    mutationFn: (content: string) =>
      api.rooms.sendMessage(roomId, { content }),
    onMutate: (content: string) => {
      const optimisticId = `optimistic-${Date.now()}`;
      queryClient.setQueryData<RoomDetail>(
        queryKeys.rooms.detail(roomId),
        (prev) => {
          if (!prev || !me?.person.id) return prev;
          return {
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: optimisticId,
                room_id: roomId,
                kind: "human",
                content,
                sender_person_id: me.person.id,
                created_at: new Date().toISOString(),
              },
            ],
          };
        },
      );
      return { optimisticId };
    },
    onSuccess: (res, _content, ctx) => {
      // Replace the optimistic line with the persisted server row in
      // place — no flicker, no duplicate render. SSE invalidation
      // catches anything we miss.
      if (ctx) {
        queryClient.setQueryData<RoomDetail>(
          queryKeys.rooms.detail(roomId),
          (prev) => {
            if (!prev) return prev;
            const idx = prev.messages.findIndex((m) => m.id === ctx.optimisticId);
            if (idx === -1) return prev;
            const next = prev.messages.slice();
            next[idx] = res.message;
            return { ...prev, messages: next };
          },
        );
      }
      // Background refetch so we pick up agent responses arriving
      // via SSE in case events lag.
      queryClient.invalidateQueries({ queryKey: queryKeys.rooms.detail(roomId) });
    },
    onError: (_err, _content, ctx) => {
      // Roll back the optimistic line so the user can retry.
      if (!ctx) return;
      queryClient.setQueryData<RoomDetail>(
        queryKeys.rooms.detail(roomId),
        (prev) =>
          prev
            ? { ...prev, messages: prev.messages.filter((m) => m.id !== ctx.optimisticId) }
            : prev,
      );
    },
  });

  // Scroll to bottom on new messages or while a turn is pending.
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [data?.messages.length, send.isPending]);

  if (!isApiConfigured) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState icon={Users} title="API not configured" />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="flex-1 px-6 py-6">
        <Skeleton className="h-12 w-1/2 mb-4" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load room"
          description={`Room ${roomId} could not be fetched.`}
        />
      </div>
    );
  }

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const content = draft.trim();
    if (content.length === 0 || send.isPending) return;
    setDraft(""); // clear textarea optimistically so re-typing feels instant
    send.mutate(content);
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        <RoomHeader room={data} myPersonId={me?.person.id} />
        <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-3xl mx-auto space-y-3">
            {data.messages.length === 0 ? (
              <EmptyMessages members={data.members} />
            ) : (
              data.messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  members={data.members}
                  myPersonId={me?.person.id}
                />
              ))
            )}
            {send.isPending ? <Pending /> : null}
            {send.error ? (
              <div className="rounded-lg border border-status-failed/40 bg-status-failed/5 p-3 text-xs">
                <div className="flex items-center gap-1.5 text-status-failed font-medium mb-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Couldn&apos;t send
                </div>
                <div className="text-muted-foreground">{(send.error as Error).message}</div>
              </div>
            ) : null}
          </div>
        </div>
        <Composer
          draft={draft}
          setDraft={setDraft}
          submit={submit}
          isPending={send.isPending}
          members={data.members}
        />
      </div>
      <LivePanel />
    </div>
  );
}

function RoomHeader({
  room,
  myPersonId,
}: {
  room: RoomDetail;
  myPersonId: string | undefined;
}) {
  const [inviting, setInviting] = useState(false);
  return (
    <header className="px-6 pt-6 pb-3 border-b border-border/60 flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight truncate">{room.room.name}</h1>
        <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
          <Users className="h-3.5 w-3.5" />
          {room.members.map((m, i) => (
            <span key={`${m.kind}:${m.id}`} className="inline-flex items-center gap-1">
              {i > 0 ? <span className="text-muted-foreground/50">·</span> : null}
              <MemberPill m={m} myPersonId={myPersonId} />
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setInviting(true)}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer shrink-0"
      >
        <UserPlus className="h-3 w-3" />
        Invite
      </button>
      {inviting ? (
        <InviteDialog roomId={room.room.id} onClose={() => setInviting(false)} />
      ) : null}
    </header>
  );
}

function MemberPill({ m, myPersonId }: { m: RoomMemberDetail; myPersonId?: string }) {
  if (m.kind === "person") {
    const isMe = m.id === myPersonId;
    return (
      <span className="inline-flex items-center gap-1">
        <span className="text-foreground/85">{m.name}{isMe ? " (you)" : ""}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Bot className="h-3 w-3 text-muted-foreground/80" />
      <Link href={`/agents/${m.id}`} className="text-foreground/85 hover:underline">
        {m.name}
      </Link>
    </span>
  );
}

function InviteDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** When the invitee doesn't have an account yet, surface a share link they can use to sign up + auto-join. */
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: () => api.rooms.invite(roomId, { email: email.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rooms.detail(roomId) });
      onClose();
    },
    onError: (err) => {
      // person_not_found is the common case: the invitee hasn't signed up
      // yet. Show a copyable share link instead — they sign up via that
      // URL and land in this room as their first session.
      if (err instanceof ApiError && err.errorCode === "person_not_found") {
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const link = `${origin}/sign-up?room=${encodeURIComponent(roomId)}&email=${encodeURIComponent(email.trim())}`;
        setShareLink(link);
        setError(null);
      } else {
        setShareLink(null);
        setError(describeError(err));
      }
    },
  });

  const copyLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API can fail in non-secure contexts; user can still
      // long-press the input and copy manually.
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 bg-background/60 backdrop-blur-sm flex items-center justify-center"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!email.trim()) return;
          setError(null);
          setShareLink(null);
          invite.mutate();
        }}
        className="bg-card border border-border rounded-lg p-5 w-full max-w-md shadow-md"
      >
        <h3 className="text-sm font-semibold mb-1">Invite to room</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Enter the invitee&apos;s email. If they already have a beevibe account they&apos;re
          added immediately. If not, you&apos;ll get a sign-up link to share.
        </p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          placeholder="alice@example.com"
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={invite.isPending}
        />
        {error ? (
          <div className="mt-2 text-xs text-status-failed flex items-start gap-1.5">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        {shareLink ? (
          <div className="mt-3 rounded border border-border bg-muted/40 p-3">
            <div className="text-[11px] text-muted-foreground mb-1.5">
              No account for that email yet. Send them this link — they&apos;ll sign up and
              land in this room.
            </div>
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={shareLink}
                className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-[11px] font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                onClick={copyLink}
                className="h-7 px-2.5 rounded text-[11px] font-medium border border-border hover:bg-secondary transition-colors cursor-pointer shrink-0"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer"
          >
            {shareLink ? "Done" : "Cancel"}
          </button>
          {shareLink ? null : (
            <button
              type="submit"
              disabled={invite.isPending || email.trim().length === 0}
              className="h-8 px-3 rounded text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {invite.isPending ? "Inviting…" : "Invite"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  members,
  myPersonId,
}: {
  message: RoomMessage;
  members: RoomMemberDetail[];
  myPersonId?: string;
}) {
  const sender = useMemo(() => {
    if (message.kind === "human") {
      return members.find((m) => m.kind === "person" && m.id === message.sender_person_id);
    }
    return members.find((m) => m.kind === "agent" && m.id === message.sender_agent_id);
  }, [message, members]);

  const isMine =
    message.kind === "human" && message.sender_person_id === myPersonId;
  const isAgent = message.kind === "agent";

  return (
    <div className={cn("flex flex-col", isMine ? "items-end" : "items-start")}>
      <div className="text-[10px] text-muted-foreground/80 mb-0.5 px-1">
        {sender?.kind === "agent" ? (
          <span className="inline-flex items-center gap-1">
            <Bot className="h-2.5 w-2.5" />
            {sender.name}
          </span>
        ) : sender?.kind === "person" ? (
          <span>
            {sender.name}
            {sender.id === myPersonId ? " (you)" : ""}
          </span>
        ) : (
          <span>(unknown)</span>
        )}
        <span className="ml-1.5 text-muted-foreground/60">
          {formatRelativeTime(message.created_at)}
        </span>
      </div>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2",
          isMine
            ? "bg-primary text-primary-foreground"
            : isAgent
            ? "bg-secondary text-foreground border border-border"
            : "bg-muted text-foreground",
        )}
      >
        {isAgent ? (
          <ChatMarkdown content={message.content} />
        ) : (
          <div className="text-sm whitespace-pre-wrap">{message.content}</div>
        )}
        {message.session_id ? (
          <div className="mt-1.5 text-[10px] font-mono opacity-70">
            <Link href={sessionHref(message.session_id)} className="hover:underline">
              {shortId(message.session_id)}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Pending() {
  return (
    <div className="flex flex-col items-start">
      <div className="rounded-lg px-3 py-2 bg-secondary text-foreground border border-border">
        <div className="flex items-center gap-2 text-muted-foreground italic text-sm">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:200ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:400ms]" />
          </span>
          <span>working…</span>
        </div>
      </div>
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  submit,
  isPending,
  members,
}: {
  draft: string;
  setDraft: (s: string) => void;
  submit: () => void;
  isPending: boolean;
  members: RoomMemberDetail[];
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  // Suggest @mentions by listing agent names.
  const agents = members.filter((m): m is Extract<RoomMemberDetail, { kind: "agent" }> => m.kind === "agent");
  return (
    <div className="border-t border-border/60 px-6 py-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a message — use @ to mention an agent (Enter to send, Shift+Enter for newline)"
            rows={2}
            disabled={isPending}
            className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={isPending || draft.trim().length === 0}
            aria-label="Send"
            className="h-9 w-9 inline-flex items-center justify-center rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
        {agents.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            <span className="text-muted-foreground/70">Agents in this room:</span>
            {agents.map((a) => {
              const tag = `@${a.id.split("_").slice(1).join("_") || a.id}`;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setDraft((draft + " " + tag).trimStart())}
                  className="inline-flex items-center gap-1 rounded border border-border bg-card hover:bg-secondary px-1.5 py-0.5 text-foreground/80 transition-colors cursor-pointer"
                  title={`Mention ${a.name}`}
                >
                  <Bot className="h-2.5 w-2.5" />
                  {a.name}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EmptyMessages({ members }: { members: RoomMemberDetail[] }) {
  return (
    <div className="text-sm text-muted-foreground text-center pt-12">
      <Sparkles className="h-7 w-7 mx-auto mb-3 text-muted-foreground/50" />
      <div className="mb-1 text-foreground font-medium text-base">Room is empty — say hi.</div>
      <div className="text-xs text-muted-foreground/80 max-w-md mx-auto">
        Humans in this room can chat with each other directly. To invoke an agent, @mention it.
        {members.some((m) => m.kind === "agent")
          ? " The chips below the composer show what's available."
          : null}
      </div>
    </div>
  );
}
