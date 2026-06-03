"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Handshake,
  Loader2,
  Send,
  X,
} from "lucide-react";
import {
  api,
  type AlignmentActionItem,
  type AlignmentDigest,
  type AlignmentMeetingDetail,
} from "@/lib/api/client";
import { describeError } from "@/lib/api/http";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { EmptyState } from "@/components/empty-state";
import { ChatMarkdown } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";

interface Msg {
  id: string;
  role: "user" | "agent";
  content: string;
}

type Tab = "team" | "actions" | "notes";

const OPENER =
  "Let's run an alignment meeting. Walk me through each teammate — what they " +
  "believe right now and anywhere they might have drifted from how we actually " +
  "work. Keep it plain.";

export function MeetingRoomClient({ meetingId }: { meetingId: string }) {
  const queryClient = useQueryClient();
  const detailKey = queryKeys.alignment.detail(meetingId);
  const { data, isLoading, isError } = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => api.alignment.get(meetingId, { signal }),
    enabled: isApiConfigured,
  });

  const [tab, setTab] = useState<Tab>("team");
  const [messages, setMessages] = useState<Msg[]>([]);
  const lastSessionId = useRef<string | null>(null);
  const seeded = useRef(false);

  // Restore the conversation if this meeting already has a linked chat session.
  useEffect(() => {
    const chatSid = data?.meeting.chat_session_id;
    if (!chatSid || seeded.current) return;
    seeded.current = true;
    api.chat
      .history({ conversationId: chatSid })
      .then((h) => {
        setMessages(
          h.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })),
        );
        lastSessionId.current = h.prior_session_id ?? chatSid;
      })
      .catch(() => {
        /* a fresh meeting may have no history yet */
      });
  }, [data?.meeting.chat_session_id]);

  const send = useMutation({
    mutationFn: (text: string) =>
      api.chat.send({
        message: text,
        ...(lastSessionId.current
          ? { prior_session_id: lastSessionId.current }
          : {}),
      }),
    onSuccess: async (resp) => {
      setMessages((prev) => [
        ...prev,
        { id: `a_${resp.session_id}`, role: "agent", content: resp.response },
      ]);
      // First turn pins the conversation to the meeting so the team agent's
      // correct_subordinate_memory tool can attach fixes to it.
      if (!lastSessionId.current && !data?.meeting.chat_session_id) {
        try {
          await api.alignment.linkSession(meetingId, resp.session_id);
        } catch {
          /* non-fatal */
        }
      }
      lastSessionId.current = resp.session_id;
      // The agent may have applied corrections mid-turn — refresh action items.
      queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || send.isPending) return;
    setMessages((prev) => [
      ...prev,
      { id: `u_${Date.now()}`, role: "user", content: trimmed },
    ]);
    send.mutate(trimmed);
  }

  if (!isApiConfigured) {
    return (
      <Shell>
        <EmptyState
          icon={Handshake}
          title="Not connected"
          description="Set NEXT_PUBLIC_BV_API_URL and run the API."
        />
      </Shell>
    );
  }
  if (isError) {
    return (
      <Shell>
        <EmptyState icon={AlertTriangle} title="Couldn't load this meeting" />
      </Shell>
    );
  }
  if (isLoading || !data) {
    return (
      <Shell>
        <div className="h-40 rounded-md bg-secondary/30 animate-pulse" />
      </Shell>
    );
  }

  return (
    <div className="flex-1 flex min-h-0">
      {/* Conversation */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-3">
          <Link
            href="/alignment"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Meetings
          </Link>
          <span className="text-sm font-medium">Alignment meeting</span>
          <WrapButton meetingId={meetingId} status={data.meeting.status} detailKey={detailKey} />
        </header>

        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="mx-auto max-w-2xl space-y-4">
            {messages.length === 0 && (
              <div className="rounded-lg border border-border/60 bg-secondary/20 p-4 text-sm text-muted-foreground">
                <p className="mb-3">
                  Your team agent is ready. Open with a walkthrough, or read the
                  teammate cards on the right and ask about anything that looks off.
                </p>
                <button
                  type="button"
                  onClick={() => submit(OPENER)}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  <Handshake className="h-3.5 w-3.5" />
                  Walk me through the team
                </button>
              </div>
            )}
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} />
            ))}
            {send.isPending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Your team agent is thinking…
              </div>
            )}
            {send.isError && (
              <div className="text-sm text-[hsl(var(--status-failed))]">
                {describeError(send.error)}
              </div>
            )}
          </div>
        </div>

        <Composer onSubmit={submit} disabled={send.isPending} />
      </div>

      {/* Right rail */}
      <aside className="hidden lg:flex w-[380px] shrink-0 flex-col border-l border-border/60">
        <div className="flex border-b border-border/60 text-sm">
          <TabButton active={tab === "team"} onClick={() => setTab("team")}>
            Teammates ({data.digests.length})
          </TabButton>
          <TabButton active={tab === "actions"} onClick={() => setTab("actions")}>
            Actions ({data.action_items.filter((a) => a.status === "open").length})
          </TabButton>
          <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>
            Notes
          </TabButton>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {tab === "team" && <TeammatesTab data={data} />}
          {tab === "actions" && (
            <ActionsTab data={data} detailKey={detailKey} />
          )}
          {tab === "notes" && (
            <NotesTab meetingId={meetingId} initialNotes={data.meeting.notes} detailKey={detailKey} />
          )}
        </div>
      </aside>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <Link
          href="/alignment"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Meetings
        </Link>
        {children}
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5",
          isUser ? "glass-bubble-user" : "glass-bubble-agent",
        )}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
        ) : (
          <ChatMarkdown content={msg.content} />
        )}
      </div>
    </div>
  );
}

function Composer({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <div className="border-t border-border/60 px-6 py-3">
      <form
        className="mx-auto flex max-w-2xl items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(text);
          setText("");
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(text);
              setText("");
            }
          }}
          rows={1}
          placeholder="Talk to your team agent…"
          className="glass-surface min-h-[40px] max-h-40 flex-1 resize-none rounded-xl px-3.5 py-2.5 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 px-3 py-2.5 text-xs font-medium transition-colors",
        active
          ? "border-b-2 border-primary text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function TeammatesTab({ data }: { data: AlignmentMeetingDetail }) {
  if (data.digests.length === 0) {
    return (
      <EmptyState
        icon={Handshake}
        title="No specialists yet"
        description="This team has no subordinate agents to review."
      />
    );
  }
  return (
    <div className="space-y-4">
      {data.digests.map((d) => (
        <DigestCard
          key={d.id}
          digest={d}
          name={data.agents[d.agent_id]?.name ?? d.agent_id}
        />
      ))}
      <p className="pt-1 text-[11px] text-muted-foreground">
        Summarized from each teammate&rsquo;s memory by a local model. Spot
        something off? Tell your team agent — it can fix it in place.
      </p>
    </div>
  );
}

function DigestCard({ digest, name }: { digest: AlignmentDigest; name: string }) {
  const s = digest.summary;
  return (
    <div className="rounded-lg border border-border/80 bg-background p-3.5">
      <div className="mb-2 text-sm font-semibold">{name}</div>
      <Section label="Believes" items={s.believes} accent />
      <Section label="Knows" items={s.knows} />
      <Section label="Working on" items={s.working_on} />
      <Section label="Rules" items={s.rules} />
      {s.believes.length === 0 &&
        s.knows.length === 0 &&
        s.working_on.length === 0 &&
        s.rules.length === 0 && (
          <p className="text-xs text-muted-foreground">No memory yet.</p>
        )}
    </div>
  );
}

function Section({
  label,
  items,
  accent,
}: {
  label: string;
  items: string[];
  accent?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2.5 last:mb-0">
      <div
        className={cn(
          "mb-1 text-[11px] font-medium uppercase tracking-wide",
          accent ? "text-primary" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-xs leading-relaxed text-foreground/90">
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionsTab({
  data,
  detailKey,
}: {
  data: AlignmentMeetingDetail;
  detailKey: readonly unknown[];
}) {
  if (data.action_items.length === 0) {
    return (
      <EmptyState
        icon={Check}
        title="No action items"
        description="As you confirm fixes with your team agent, they show up here — applied and logged."
      />
    );
  }
  return (
    <div className="space-y-2.5">
      {data.action_items.map((a) => (
        <ActionCard
          key={a.id}
          item={a}
          name={data.agents[a.agent_id]?.name ?? a.agent_id}
          detailKey={detailKey}
        />
      ))}
    </div>
  );
}

function ActionCard({
  item,
  name,
  detailKey,
}: {
  item: AlignmentActionItem;
  name: string;
  detailKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const apply = useMutation({
    mutationFn: () => api.alignment.applyActionItem(item.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: detailKey }),
  });
  const dismiss = useMutation({
    mutationFn: () => api.alignment.dismissActionItem(item.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: detailKey }),
  });
  const busy = apply.isPending || dismiss.isPending;

  return (
    <div className="rounded-lg border border-border/80 bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug">{item.title}</span>
        <ActionStatus status={item.status} />
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{name}</div>
      {item.rationale.trim() && (
        <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
          {item.rationale}
        </p>
      )}
      {item.status === "open" && (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={() => apply.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {apply.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            Apply
          </button>
          <button
            type="button"
            onClick={() => dismiss.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-secondary/40 disabled:opacity-50"
          >
            <X className="h-3 w-3" />
            Dismiss
          </button>
        </div>
      )}
      {(apply.isError || dismiss.isError) && (
        <p className="mt-1.5 text-[11px] text-[hsl(var(--status-failed))]">
          {describeError(apply.error ?? dismiss.error)}
        </p>
      )}
    </div>
  );
}

function ActionStatus({ status }: { status: AlignmentActionItem["status"] }) {
  if (status === "applied") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[hsl(var(--status-done))]/15 px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--status-done))]">
        <Check className="h-3 w-3" />
        Applied
      </span>
    );
  }
  if (status === "dismissed") {
    return (
      <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        Dismissed
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-[hsl(var(--status-review))]/15 px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--status-review))]">
      Open
    </span>
  );
}

function NotesTab({
  meetingId,
  initialNotes,
  detailKey,
}: {
  meetingId: string;
  initialNotes: string;
  detailKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState(initialNotes);
  const save = useMutation({
    mutationFn: () => api.alignment.saveNotes(meetingId, notes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: detailKey }),
  });
  return (
    <div className="flex h-full flex-col">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Meeting notes — decisions, follow-ups, anything worth remembering…"
        className="glass-surface min-h-[200px] flex-1 resize-none rounded-lg p-3 text-sm outline-none"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {save.isSuccess && !save.isPending ? "Saved" : "Markdown supported"}
        </span>
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || notes === initialNotes}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save notes
        </button>
      </div>
    </div>
  );
}

function WrapButton({
  meetingId,
  status,
  detailKey,
}: {
  meetingId: string;
  status: string;
  detailKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const wrap = useMutation({
    mutationFn: () => api.alignment.wrap(meetingId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: detailKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.alignment.all });
    },
  });
  if (status === "wrapped") {
    return (
      <span className="text-xs text-muted-foreground">Wrapped</span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => wrap.mutate()}
      disabled={wrap.isPending}
      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-secondary/40 disabled:opacity-50"
    >
      {wrap.isPending ? "Wrapping…" : "Wrap up"}
    </button>
  );
}
