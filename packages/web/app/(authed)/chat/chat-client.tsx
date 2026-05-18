"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  MessageSquare,
  Terminal,
} from "lucide-react";
import type { HierarchyLevel, KnownCli } from "@beevibe/core";
import { isKnownCli, KNOWN_CLIS } from "@beevibe/core/domain";
import { isApiConfigured } from "@/lib/api/config";
import {
  api,
  type ChatConversationsResponse,
  type RuntimesListResponse,
  type SuggestedAction,
} from "@/lib/api/client";
import { useChat, type ChatMessage } from "@/lib/hooks/use-chat";
import { useChatStream, type ChatStreamStep } from "@/lib/chat-stream";
import { useMe } from "@/lib/hooks/use-me";
import { useAgents } from "@/lib/hooks/use-agents";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/avatar";
import { ReferenceCards } from "@/components/chat/reference-cards";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ToolStepList } from "@/components/chat/tool-step-list";

function useTeamAgent() {
  const agents = useAgents();
  const teamAgent = agents.data?.find((a) => a.hierarchy !== "ic");
  const initial = (teamAgent?.display_name ?? teamAgent?.name ?? "?").charAt(0).toUpperCase();
  const kind: HierarchyLevel = teamAgent?.hierarchy ?? "team";
  return { initial, kind };
}

const PROMPT_SUGGESTIONS = [
  "What's on the team's plate today?",
  "Brief me on what changed in the past 24 hours.",
  "Create a task to refactor the billing module.",
  "Which agents are blocked right now?",
];

const ONBOARDING_PROMPT_SUGGESTIONS = [
  "Hi! Tell me what you're working on.",
  "Introduce yourself.",
  "What can you do for me?",
];

const RUNTIME_LABELS: Record<KnownCli, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

function runtimeStatusSuffix(counts: { online: number; total: number }): string {
  if (counts.online > 1) return ` (${counts.online} online)`;
  if (counts.online === 1) return "";
  if (counts.total > 0) return " (offline)";
  return " (not set up)";
}

export function ChatClient() {
  const [draft, setDraft] = useState("");
  const [runtimeType, setRuntimeType] = useState<KnownCli>("claude");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: me } = useMe();

  // The welcome wizard's last step navigates here with `?from=welcome`,
  // which keeps us on /chat for the onboarding turn even though
  // `needs_onboarding` is still true on the server (it flips after the
  // first chat completes). Without this hint we'd ping-pong between
  // /welcome and / during the first chat.
  const fromWelcome = searchParams?.get("from") === "welcome";
  const isOnboardingChat = !!me?.needs_onboarding && fromWelcome;
  // `?c=<head_id>` opens a specific conversation; `?new=1` opens a fresh
  // empty surface that becomes a new chain on first send.
  const conversationParam = searchParams?.get("c") ?? undefined;
  const isFresh = searchParams?.get("new") === "1";

  const { messages, send, isPending, isSubmitting, error, pendingSessionId, pinnedRuntimeCli } =
    useChat({
      conversationId: conversationParam,
      fresh: isFresh,
    });

  // Once we load a conversation that's already claimed a runtime, mirror
  // its CLI into the picker so the user sees the pinned value (instead
  // of the "claude" default) and can't accidentally pick a different
  // CLI — the server would 409 with `runtime_switch_requires_new_chat`.
  useEffect(() => {
    if (pinnedRuntimeCli && pinnedRuntimeCli !== runtimeType) {
      setRuntimeType(pinnedRuntimeCli);
    }
  }, [pinnedRuntimeCli, runtimeType]);
  const liveSteps = useChatStream(pendingSessionId);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const teamAgent = useTeamAgent();

  // After the user sends their first message in a `?new=1` surface, drop
  // the `new` param so reload restores the just-started conversation
  // instead of bouncing the user back into an empty surface. Gate on
  // `isSubmitting` (local mutation) — a foreign-tab pending session
  // shouldn't keep this surface stuck on `?new=1`.
  useEffect(() => {
    if (isFresh && messages.length > 0 && !isSubmitting) {
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      sp.delete("new");
      const qs = sp.toString();
      router.replace(qs ? `/chat?${qs}` : "/chat");
    }
  }, [isFresh, messages.length, isSubmitting, searchParams, router]);

  // First-run gate: if the caller hasn't completed the welcome wizard
  // and didn't arrive here from it, bounce them to the wizard.
  useEffect(() => {
    if (me?.needs_onboarding && !fromWelcome) router.replace("/welcome");
  }, [me?.needs_onboarding, fromWelcome, router]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isPending, liveSteps.length]);

  if (!isApiConfigured) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-md text-center text-sm text-muted-foreground">
          <MessageSquare className="h-6 w-6 mx-auto mb-2 text-muted-foreground/60" />
          <div className="text-foreground font-medium mb-1">Chat not connected</div>
          Set <span className="font-mono">NEXT_PUBLIC_BV_API_URL</span> in{" "}
          <span className="font-mono">.env.local</span> to start chatting with your team agent.
        </div>
      </div>
    );
  }

  const submit = (text?: string) => {
    const value = text ?? draft;
    if (value.trim().length === 0) return;
    send(value, runtimeType);
    setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Conversation list lives in the main app sidebar (Notion-style:
          one rail morphs by route). Standalone ConversationSidebar
          here would stack three rails, which is what the design audit
          flagged as the chat page's biggest cognitive-load source. */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Two layouts: hero empty state when no messages, conversation
            transcript otherwise. The hero centers the input vertically
            with the agent avatar above and recent/suggested below — same
            shape as Notion's "How can I help you today?" surface. */}
        {messages.length === 0 && !isPending ? (
          <HeroEmptyChat
            onSubmit={submit}
            draft={draft}
            setDraft={setDraft}
            onboarding={isOnboardingChat}
            runtimeType={runtimeType}
            setRuntimeType={setRuntimeType}
          />
        ) : (
          <>
            <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-8">
              <div className="max-w-3xl mx-auto">
                {messages.map((m, i) => {
                  const prev = messages[i - 1];
                  const isFirstInGroup = !prev || prev.role !== m.role;
                  return (
                    <Bubble
                      key={m.id}
                      message={m}
                      showSuggestions={!isPending && i === messages.length - 1}
                      onSuggest={submit}
                      teamAgent={teamAgent}
                      isFirstInGroup={isFirstInGroup}
                    />
                  );
                })}
                {isPending ? <Thinking steps={liveSteps} teamAgent={teamAgent} /> : null}
                {error ? (
                  <div className="mt-4 rounded-lg border border-status-failed/40 bg-status-failed/5 p-3 text-xs">
                    <div className="flex items-center gap-1.5 text-status-failed font-medium mb-1">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Couldn&apos;t reach the agent
                    </div>
                    <div className="text-muted-foreground">{error.message}</div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="px-6 pb-5 pt-2">
              <div className="max-w-3xl mx-auto rounded-xl border border-border bg-card focus-within:ring-2 focus-within:ring-ring transition-shadow">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Reply to your team…"
                  rows={2}
                  disabled={isSubmitting}
                  className="w-full bg-transparent px-4 pt-3 pb-1 text-sm focus:outline-none resize-none placeholder:text-muted-foreground/60 disabled:opacity-60"
                />
                <div className="flex items-center justify-between gap-3 px-3 pb-2">
                  <RuntimeSelector
                    value={runtimeType}
                    onChange={setRuntimeType}
                    disabled={isSubmitting}
                    pinned={pinnedRuntimeCli}
                  />
                  <button
                    type="button"
                    onClick={() => submit()}
                    disabled={isPending || draft.trim().length === 0}
                    aria-label="Send"
                    className="h-7 w-7 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HeroEmptyChat({
  onSubmit,
  draft,
  setDraft,
  onboarding,
  runtimeType,
  setRuntimeType,
}: {
  onSubmit: (text?: string) => void;
  draft: string;
  setDraft: (s: string) => void;
  onboarding: boolean;
  runtimeType: KnownCli;
  setRuntimeType: (runtimeType: KnownCli) => void;
}) {
  const agents = useAgents();
  const teamAgent = agents.data?.find((a) => a.hierarchy !== "ic");
  const initial = (teamAgent?.display_name ?? teamAgent?.name ?? "?").charAt(0).toUpperCase();

  const conversations = useQuery<ChatConversationsResponse>({
    queryKey: queryKeys.chat.conversations(),
    queryFn: ({ signal }) => api.chat.conversations({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });
  const recentChats = (conversations.data?.conversations ?? []).slice(0, 4);
  const suggestions = onboarding ? ONBOARDING_PROMPT_SUGGESTIONS : PROMPT_SUGGESTIONS;

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 pt-24 pb-12">
        {/* Hero: avatar + heading. Centered, generous whitespace. */}
        <div className="flex flex-col items-center text-center mb-8">
          {teamAgent ? (
            <Avatar initial={initial} kind={teamAgent.hierarchy} size={56} />
          ) : (
            <Avatar initial="?" kind="team" size={56} />
          )}
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">
            How can your team help you today?
          </h1>
        </div>

        {/* Centered input. The composer sits in the middle of the page
            instead of the bottom-stuck position used during a real
            conversation — same shape as Notion's "Do anything with AI..." */}
        <div className="rounded-xl border border-border bg-card focus-within:ring-2 focus-within:ring-ring transition-shadow">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask your team agent…"
            rows={3}
            autoFocus
            className="w-full bg-transparent px-4 pt-3 pb-2 text-sm focus:outline-none resize-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center justify-between gap-3 px-3 pb-2">
            <RuntimeSelector value={runtimeType} onChange={setRuntimeType} />
            <button
              type="button"
              onClick={() => onSubmit()}
              disabled={draft.trim().length === 0}
              aria-label="Send"
              className="h-7 w-7 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Two columns: recent chats on the left, suggested prompts on
            the right. Same Notion shape — ground the surface in what
            you've been doing AND what you could do next. */}
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-2">
          <HeroSection title="Recent chats">
            {recentChats.length === 0 ? (
              <p className="text-xs text-muted-foreground/60 italic">No conversations yet.</p>
            ) : (
              <ul className="space-y-1">
                {recentChats.map((c) => (
                  <li key={c.head_id}>
                    <Link
                      href={`/chat?c=${encodeURIComponent(c.head_id)}`}
                      className="flex items-baseline gap-2 px-1 py-1 rounded hover:bg-secondary/40 transition-colors"
                    >
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 self-center" />
                      <span className="text-sm font-medium text-foreground/90 truncate flex-1 min-w-0">
                        {c.title}
                      </span>
                      <span className="text-[10px] tabular-nums text-muted-foreground/60 shrink-0">
                        {formatRelativeTime(c.last_at)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </HeroSection>

          <HeroSection title="Suggested">
            <ul className="space-y-1">
              {suggestions.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => onSubmit(s)}
                    className="w-full text-left px-1 py-1 rounded hover:bg-secondary/40 transition-colors text-sm font-medium text-foreground/90"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </HeroSection>
        </div>
      </div>
    </div>
  );
}

function RuntimeSelector({
  value,
  onChange,
  disabled,
  pinned,
}: {
  value: KnownCli;
  onChange: (runtimeType: KnownCli) => void;
  disabled?: boolean;
  /**
   * Set when the current conversation has already claimed a runtime —
   * the picker locks to that CLI because the server pins runtime per
   * chain (switching mid-chat 409s). Empty conversations leave this
   * unset and the user can pick freely.
   */
  pinned?: KnownCli;
}) {
  const runtimesQuery = useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });

  const runtimeCounts = useMemo(() => {
    const countsByCli = new Map<KnownCli, { online: number; total: number }>();
    for (const cli of KNOWN_CLIS) countsByCli.set(cli, { online: 0, total: 0 });
    for (const daemon of runtimesQuery.data?.daemons ?? []) {
      for (const runtime of daemon.runtimes) {
        if (!isKnownCli(runtime.cli)) continue;
        const counts = countsByCli.get(runtime.cli)!;
        counts.total += 1;
        if (runtime.online) counts.online += 1;
      }
    }
    return countsByCli;
  }, [runtimesQuery.data]);

  // The parent seeds `value` with a hardcoded default ("claude"). On the
  // first arrival of runtime data, swap to the first online CLI if the
  // default has none — that's a one-shot default-correction, not an
  // ongoing override. Switching silently on every poll would steal the
  // user's deliberate selection if their CLI flickered offline mid-session.
  // Skip entirely when the conversation is pinned; the parent already
  // mirrored that CLI into `value`.
  const didInitialPick = useRef(false);
  useEffect(() => {
    if (pinned || didInitialPick.current || !runtimesQuery.data) return;
    didInitialPick.current = true;
    if ((runtimeCounts.get(value)?.online ?? 0) > 0) return;
    const firstOnline = KNOWN_CLIS.find((cli) => (runtimeCounts.get(cli)?.online ?? 0) > 0);
    if (firstOnline) onChange(firstOnline);
  }, [pinned, runtimesQuery.data, runtimeCounts, value, onChange]);

  const locked = pinned !== undefined;
  return (
    <label className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Terminal className="h-3.5 w-3.5 shrink-0" />
      <select
        value={value}
        disabled={disabled || locked || runtimesQuery.isLoading}
        onChange={(e) => onChange(e.target.value as KnownCli)}
        title={
          locked
            ? "This conversation is pinned to this runtime. Start a new chat to switch."
            : "Choose the runtime for this chat turn"
        }
        className="max-w-[160px] rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none transition-colors hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {KNOWN_CLIS.map((cli) => {
          const counts = runtimeCounts.get(cli) ?? { online: 0, total: 0 };
          return (
            <option key={cli} value={cli} disabled={counts.online === 0}>
              {RUNTIME_LABELS[cli]}
              {runtimeStatusSuffix(counts)}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function HeroSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xs text-muted-foreground/70 mb-2 px-1">{title}</h2>
      {children}
    </div>
  );
}

function Bubble({
  message,
  showSuggestions,
  onSuggest,
  teamAgent,
  isFirstInGroup,
}: {
  message: ChatMessage;
  showSuggestions?: boolean;
  onSuggest?: (label: string) => void;
  teamAgent: { initial: string; kind: HierarchyLevel };
  isFirstInGroup: boolean;
}) {
  const isUser = message.role === "user";
  const refIds = !isUser ? message.view_refs ?? [] : [];
  const suggestions = showSuggestions ? message.suggested_actions ?? [] : [];
  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start",
        isFirstInGroup ? "mt-4" : "mt-1",
      )}
    >
      {!isUser ? (
        <div className="w-7 mr-2 shrink-0 flex justify-center">
          {isFirstInGroup ? (
            <Avatar initial={teamAgent.initial} kind={teamAgent.kind} size={28} />
          ) : null}
        </div>
      ) : null}
      <div className={cn("flex flex-col max-w-[78%]", isUser ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2",
            isUser ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
          )}
        >
          {isUser ? (
            <div className="text-sm whitespace-pre-wrap">{message.content}</div>
          ) : (
            <ChatMarkdown content={message.content} inverted={false} />
          )}
          {refIds.length > 0 ? <ReferenceCards ids={refIds} /> : null}
          {message.open_view ? <OpenViewCta open_view={message.open_view} /> : null}
        </div>
        {suggestions.length > 0 && onSuggest ? (
          <SuggestedActions actions={suggestions} onPick={onSuggest} />
        ) : null}
      </div>
    </div>
  );
}

function SuggestedActions({
  actions,
  onPick,
}: {
  actions: SuggestedAction[];
  onPick: (text: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={() => onPick(a.prompt ?? a.label)}
          title={a.prompt && a.prompt !== a.label ? a.prompt : undefined}
          className="text-left rounded-md border border-border bg-card hover:bg-secondary hover:border-foreground/30 px-2.5 py-1.5 text-xs text-foreground transition-colors cursor-pointer"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

function OpenViewCta({ open_view }: { open_view: { path: string; label?: string } }) {
  return (
    <Link
      href={open_view.path}
      className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-foreground text-background hover:opacity-90 transition-opacity px-3 py-1.5 text-xs font-medium cursor-pointer"
    >
      {open_view.label ?? "Open this"}
      <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

function Thinking({
  steps,
  teamAgent,
}: {
  steps: ChatStreamStep[];
  teamAgent: { initial: string; kind: HierarchyLevel };
}) {
  // Split agent text from tool steps. Agent text is the response being
  // written; tools are the substrate beneath, categorized so the
  // audience can SEE when the agent is asking another agent (mesh) vs
  // saving memory vs reading a file. tool_result rows surface what each
  // call returned — especially failures, which used to look like an
  // empty success. Final summary arrives via POST and replaces this
  // whole block.
  const toolSteps = steps.filter(
    (s) => s.kind === "tool_call" || s.kind === "tool_result",
  );
  const agentSteps = steps.filter((s) => s.kind === "agent");
  // Each Claude turn between tool calls emits one assistant block — full
  // text, not deltas — so concatenating gives the response-so-far.
  // Each agent step is one text_delta from the runtime, so concatenation
  // happens without a separator — the model's own newlines do paragraph
  // breaks. (Pre-streaming, each step was a whole message and we joined
  // with "\n\n"; that's wrong now since deltas are mid-sentence.)
  const streamingText = agentSteps.map((s) => s.content).join("");
  // Show the latest 8 tool steps. With strong categorization the list
  // stays scannable; the running pulse on the most recent makes it
  // clear where the agent is "now."
  const recentTools = toolSteps.slice(-8);

  return (
    <div className="flex w-full justify-start mt-4">
      <div className="w-7 mr-2 shrink-0 flex justify-center">
        <Avatar initial={teamAgent.initial} kind={teamAgent.kind} size={28} />
      </div>
      <div className="max-w-[78%] rounded-2xl px-3.5 py-2 bg-secondary text-foreground">
        {streamingText ? (
          <ChatMarkdown content={streamingText} />
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground italic text-sm">
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:200ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:400ms]" />
            </span>
            <span>thinking…</span>
          </div>
        )}
        {recentTools.length > 0 ? (
          <ToolStepList
            steps={recentTools}
            totalSteps={toolSteps.length}
            withTopBorder={!!streamingText}
          />
        ) : null}
      </div>
    </div>
  );
}
