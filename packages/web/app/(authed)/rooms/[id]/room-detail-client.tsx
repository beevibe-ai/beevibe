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
import { ToolStepList } from "@/components/chat/tool-step-list";
import { useChatStream, type ChatStreamStep } from "@/lib/chat-stream";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { formatRelativeTime, idSuffix, sessionHref, shortId } from "@/lib/format";
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
    staleTime: 1_000,
    // Polling fallback — cloudflared trycloudflare quick tunnels
    // buffer SSE responses, so the bv_event channel often fails to
    // propagate to remote browsers. SSE remains the fast path when
    // it works (sub-second latency); this 3s poll guarantees the
    // room view eventually catches up regardless of the tunnel.
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
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
              data.messages.map((m, i) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  members={data.members}
                  myPersonId={me?.person.id}
                  showSuggestions={!send.isPending && i === data.messages.length - 1}
                  onSuggest={(text) => {
                    // Suggestion chips are implicitly addressed to the agent
                    // who emitted them — without an explicit @mention the
                    // server-side addressee resolver would route to nobody
                    // and the agent would silently not respond.
                    const senderId = m.sender_agent_id;
                    const short = senderId ? idSuffix(senderId) : "";
                    const addressed = short ? `@${short} ${text}` : text;
                    setDraft(addressed);
                    setTimeout(() => submit(), 0);
                  }}
                />
              ))
            )}
            {send.isPending ? <Pending /> : null}
            {(data.typing?.length ?? 0) > 0 ? (
              <TypingIndicators typing={data.typing!} />
            ) : null}
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
        <h1 className="text-base font-semibold tracking-tight leading-tight truncate">{room.room.name}</h1>
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
  showSuggestions,
  onSuggest,
}: {
  message: RoomMessage;
  members: RoomMemberDetail[];
  myPersonId?: string;
  showSuggestions?: boolean;
  onSuggest?: (text: string) => void;
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
  const suggestions = showSuggestions ? message.suggested_actions ?? [] : [];

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
      {suggestions.length > 0 && onSuggest ? (
        <div className="mt-2 max-w-[80%] flex flex-wrap gap-1.5">
          {suggestions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => onSuggest(a.prompt ?? a.label)}
              title={a.prompt && a.prompt !== a.label ? a.prompt : undefined}
              className="text-left rounded-md border border-border bg-card hover:bg-secondary hover:border-foreground/30 px-2.5 py-1.5 text-xs text-foreground transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TypingIndicators({ typing }: { typing: NonNullable<RoomDetail["typing"]> }) {
  return (
    <div className="space-y-1.5">
      {typing.map((t) => (
        <TypingBubble key={t.session_id} typing={t} />
      ))}
    </div>
  );
}

function TypingBubble({ typing: t }: { typing: NonNullable<RoomDetail["typing"]>[number] }) {
  // Two sources of tool-call steps merged by event_id:
  //   - polled (`t.recent_steps`) — works through any tunnel, refreshes
  //     every 3s with the room poll
  //   - SSE (`useChatStream`) — sub-second when the proxy doesn't
  //     buffer; empty when the SSE detector has fallen back to polling
  // Audience sees Read / Bash / ask / save_memory / search_memory
  // calls land live (or every 3s in polling-only mode).
  const sseSteps = useChatStream(t.session_id);
  const polled: ChatStreamStep[] = (t.recent_steps ?? []).map((s) => ({
    event_id: s.event_id,
    kind: s.kind,
    tool_name: s.tool_name ?? undefined,
    content: s.content,
    received_at: 0,
  }));
  const seen = new Set<string>();
  const merged: ChatStreamStep[] = [];
  for (const s of [...polled, ...sseSteps]) {
    if (seen.has(s.event_id)) continue;
    seen.add(s.event_id);
    merged.push(s);
  }
  const toolSteps = merged.filter(
    (s) => s.kind === "tool_call" || s.kind === "tool_result",
  );
  const recentTools = toolSteps.slice(-6);
  const totalSteps = Math.max(toolSteps.length, t.total_steps ?? 0);

  return (
    <div className="flex flex-col items-start">
      <div className="text-[10px] text-muted-foreground/80 mb-0.5 px-1">
        <span className="inline-flex items-center gap-1">
          <Bot className="h-2.5 w-2.5" />
          {t.agent_name}
        </span>
        <span className="ml-1.5 text-muted-foreground/60">
          started {formatRelativeTime(t.started_at)}
        </span>
      </div>
      <div className="max-w-[80%] rounded-lg px-3 py-2 bg-secondary text-foreground border border-border w-full">
        <div className="flex items-center gap-2 text-muted-foreground italic text-sm">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-status-running animate-pulse" />
            <span className="h-1.5 w-1.5 rounded-full bg-status-running animate-pulse [animation-delay:200ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-status-running animate-pulse [animation-delay:400ms]" />
          </span>
          <span>typing…</span>
        </div>
        {recentTools.length > 0 ? (
          <ToolStepList
            steps={recentTools}
            totalSteps={totalSteps}
            withTopBorder
          />
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

/**
 * Composer with @-mention autocomplete.
 *
 * Detects the in-progress `@<query>` token at the textarea cursor,
 * surfaces a typeahead list of room agents matching by name (case-
 * insensitive substring), inserts the selected agent's short id —
 * the canonical form the server-side resolver matches reliably.
 *
 * Up/Down navigates, Enter/Tab selects, Esc closes. Plain Enter (no
 * dropdown) submits the message as before.
 */
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [cursor, setCursor] = useState(0);
  const [highlight, setHighlight] = useState(0);

  // Mention candidates: agents in the room. Persons can be added too,
  // but only agents are addressable as work targets — humans get
  // notified by SSE either way.
  const agents = useMemo(
    () =>
      members.filter(
        (m): m is Extract<RoomMemberDetail, { kind: "agent" }> => m.kind === "agent",
      ),
    [members],
  );

  // Detect an in-progress `@query` ending at the cursor. Triggers the
  // dropdown when found.
  const mentionContext = useMemo(() => {
    const before = draft.slice(0, cursor);
    const m = before.match(/(^|[\s\n])@([\w'.\- ]*)$/);
    if (!m) return null;
    const queryStart = before.length - m[2].length - 1; // include the `@`
    return { query: m[2], queryStart };
  }, [draft, cursor]);

  const matches = useMemo(() => {
    if (!mentionContext) return [];
    const q = mentionContext.query.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (q === "") return agents.slice(0, 6);
    return agents
      .filter((a) => {
        const norm = a.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        const short = idSuffix(a.id).toLowerCase();
        return norm.includes(q) || short.includes(q);
      })
      .slice(0, 6);
  }, [agents, mentionContext]);

  const dropdownOpen = mentionContext !== null && matches.length > 0;

  // Reset highlight whenever the candidate list changes (typing
  // narrows the list — the previous index is probably stale).
  useEffect(() => {
    setHighlight(0);
  }, [matches.length, mentionContext?.query]);

  const insertMention = (agent: Extract<RoomMemberDetail, { kind: "agent" }>) => {
    if (!mentionContext) return;
    // Use short id as the inserted token — the server resolver
    // accepts it reliably and it's much shorter than full id.
    const short = idSuffix(agent.id);
    const before = draft.slice(0, mentionContext.queryStart);
    const after = draft.slice(cursor);
    const insertion = `@${short} `;
    const next = before + insertion + after;
    setDraft(next);
    // Move cursor to end of insertion.
    queueMicrotask(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = before.length + insertion.length;
      ta.setSelectionRange(pos, pos);
      setCursor(pos);
      ta.focus();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (dropdownOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const a = matches[highlight];
        if (a) insertMention(a);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Move cursor past the `@` to dismiss the dropdown without
        // erasing the partial query.
        const ta = textareaRef.current;
        if (ta) {
          const pos = cursor;
          ta.setSelectionRange(pos, pos);
        }
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCursor(e.currentTarget.selectionStart ?? 0);
  };

  return (
    <div className="border-t border-border/60 px-6 py-4">
      <div className="max-w-3xl mx-auto relative">
        {dropdownOpen ? (
          <div className="absolute bottom-full left-0 mb-1 w-72 max-w-full rounded-md border border-border bg-popover shadow-md z-10 overflow-hidden">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70 border-b border-border/60 bg-muted/30">
              Mention an agent
            </div>
            <ul role="listbox">
              {matches.map((a, i) => {
                const isHi = i === highlight;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isHi}
                      onMouseEnter={() => setHighlight(i)}
                      onMouseDown={(e) => {
                        // Prevent textarea blur, which would clobber selection.
                        e.preventDefault();
                        insertMention(a);
                      }}
                      className={cn(
                        "w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-sm cursor-pointer",
                        isHi ? "bg-secondary text-foreground" : "text-foreground/85 hover:bg-secondary/60",
                      )}
                    >
                      <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{a.name}</span>
                      <span className="text-[10px] font-mono text-muted-foreground/70 shrink-0">
                        {idSuffix(a.id)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onSelect={onSelect}
            onClick={onSelect}
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
            className="glassy-send h-9 w-9 inline-flex items-center justify-center rounded cursor-pointer"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
        {agents.length > 0 && !dropdownOpen ? (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            <span className="text-muted-foreground/70">Tip: type</span>
            <span className="font-mono">@</span>
            <span className="text-muted-foreground/70">to mention any of:</span>
            {agents.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1 text-foreground/80"
                title={`@${idSuffix(a.id)}`}
              >
                <Bot className="h-2.5 w-2.5" />
                {a.name}
              </span>
            ))}
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
