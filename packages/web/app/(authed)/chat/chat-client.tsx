"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  Bell,
  ChevronRight,
  MessageSquare,
  Star,
} from "lucide-react";
import type { HierarchyLevel, KnownCli } from "@beevibe/core";
import { isApiConfigured } from "@/lib/api/config";
import {
  api,
  type ChatConversationsResponse,
  type ChatRepoCard,
  type SuggestedAction,
} from "@/lib/api/client";
import { useChat, type ChatMessage } from "@/lib/hooks/use-chat";
import {
  useChatStream,
  useChatStreamTree,
  type ChatStreamStep,
  type ChatStreamTree,
} from "@/lib/chat-stream";
import { useConversation } from "@/lib/hooks/use-sessions";
import type { TranscriptEntry } from "@/lib/types/sessions";
import { useMe } from "@/lib/hooks/use-me";
import { useAgents } from "@/lib/hooks/use-agents";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import { defaultTryGoal, formatStars } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/avatar";
import { ReferenceCards } from "@/components/chat/reference-cards";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ToolStepList } from "@/components/chat/tool-step-list";
import { ChatLoader } from "@/components/chat/chat-loader";

function useTeamAgent() {
  const agents = useAgents();
  const teamAgent = agents.data?.find((a) => a.hierarchy !== "ic");
  const label = teamAgent?.display_name ?? teamAgent?.name;
  const initial = (label ?? "?").charAt(0).toUpperCase();
  const kind: HierarchyLevel = teamAgent?.hierarchy ?? "team";
  return { initial, kind, label, specialization: teamAgent?.specialization };
}

const EMPTY_STEPS: ChatStreamStep[] = [];

/**
 * Map a persisted `TranscriptEntry` to the `ChatStreamStep` shape the live
 * SSE stream produces, so completed turns render through the same
 * `ToolStepList` as the live working box. `received_at: 0` matches the
 * polled-step mapping in the room view — ordering comes from array index.
 */
const toStreamStep =
  (turnId: string) =>
  (entry: TranscriptEntry, i: number): ChatStreamStep => ({
    event_id: `${turnId}-${i}`,
    kind: entry.kind,
    ...(entry.tool_name ? { tool_name: entry.tool_name } : {}),
    content: entry.content,
    received_at: 0,
  });

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

export function ChatClient() {
  const [draft, setDraft] = useState("");
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

  const {
    messages,
    send,
    isPending,
    isSubmitting,
    error,
    pendingSessionId,
    runtimeMismatch,
    conversationId,
  } = useChat({
    conversationId: conversationParam,
    fresh: isFresh,
  });

  // Tree mode subscribes to both `session.step` and `session.spawned`
  // events for the team session AND every IC it spawns via create_task.
  // Off mode preserves the pre-tree single-session stream so the flag
  // is a true escape hatch during rollout.
  const chatTreeEnabled = process.env.NEXT_PUBLIC_CHAT_TREE_UI === "1";
  const liveTree = useChatStreamTree(chatTreeEnabled ? pendingSessionId : undefined);
  const liveStreamFlat = useChatStream(chatTreeEnabled ? undefined : pendingSessionId);
  const liveSteps: ChatStreamStep[] = chatTreeEnabled
    ? pendingSessionId
      ? liveTree.steps[pendingSessionId] ?? EMPTY_STEPS
      : EMPTY_STEPS
    : liveStreamFlat.steps;
  // Per-session step map for rendering each completed turn's working trace
  // as a collapsed disclosure. `liveMap` holds steps streamed this session;
  // `persistedStepsBySession` (below) holds the persisted transcript so the
  // trace survives reload / opening an older conversation.
  const liveMap = chatTreeEnabled ? liveTree.steps : liveStreamFlat.stepsBySession;

  // Fetch the loaded chain's persisted per-turn transcripts so a finished
  // turn's working trace renders even when its live SSE steps aren't in
  // memory (cold load, prior history). Keyed by full turn/session id.
  const headShortId = conversationId ? conversationId.slice(5, 11) : undefined;
  const conversation = useConversation(headShortId);
  const persistedStepsBySession = useMemo(() => {
    const map: Record<string, ChatStreamStep[]> = {};
    for (const turn of conversation.data?.turns ?? []) {
      map[turn.id] = turn.transcript.map(toStreamStep(turn.id));
    }
    return map;
  }, [conversation.data]);

  // Persisted wins when present (full untruncated content, richer recall
  // blocks); live is the immediate fallback for a turn that just finished
  // before the conversation query refetches — so no empty-dropdown flicker.
  const stepsFor = (sessionId: string): ChatStreamStep[] | undefined =>
    persistedStepsBySession[sessionId] ?? liveMap[sessionId];

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

  // `?draft=<text>` seeds the input — used by the Capabilities page and
  // by the blocked-task banner to drop the user into chat with a
  // pre-written message. `?send=1` additionally auto-submits the seeded
  // draft on mount so chip-style quick replies skip the "type and press
  // enter" step entirely. Both params are consumed once and stripped
  // from the URL so reloads don't repeat the auto-send.
  const draftSeed = searchParams?.get("draft");
  const autoSend = searchParams?.get("send") === "1";
  useEffect(() => {
    if (!draftSeed) return;
    setDraft(draftSeed);
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    sp.delete("draft");
    sp.delete("send");
    const qs = sp.toString();
    router.replace(qs ? `/chat?${qs}` : "/chat");
    if (autoSend && draftSeed.trim().length > 0) {
      // Fire on next tick so React Query / chat send wiring is settled.
      const id = setTimeout(() => {
        submit(draftSeed);
      }, 0);
      return () => clearTimeout(id);
    }
    // Run once per draftSeed value; intentionally narrow deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSeed]);

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
    send(value);
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
          />
        ) : (
          <>
            {runtimeMismatch ? (
              <RuntimeMismatchBanner mismatch={runtimeMismatch} />
            ) : null}
            <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-8">
              <div className="max-w-3xl mx-auto">
                {messages.map((m, i) => {
                  const prev = messages[i - 1];
                  const isFirstInGroup = !prev || prev.role !== m.role;
                  if (m.role === "system") {
                    return <SystemPill key={m.id} content={m.content} />;
                  }
                  return (
                    <Bubble
                      key={m.id}
                      message={m}
                      showSuggestions={!isPending && i === messages.length - 1}
                      onSuggest={submit}
                      teamAgent={teamAgent}
                      isFirstInGroup={isFirstInGroup}
                      steps={
                        m.role === "agent" && m.session_id
                          ? stepsFor(m.session_id)
                          : undefined
                      }
                      tree={chatTreeEnabled ? liveTree : undefined}
                    />
                  );
                })}
                {isPending ? (
                  <Thinking
                    steps={liveSteps}
                    teamAgent={teamAgent}
                    tree={chatTreeEnabled ? liveTree : undefined}
                    rootSessionId={pendingSessionId}
                  />
                ) : null}
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
              <div className="max-w-3xl mx-auto rounded-xl glass-surface focus-within:ring-2 focus-within:ring-ring transition-shadow">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Reply to your team…"
                  rows={2}
                  disabled={isSubmitting}
                  className="w-full bg-transparent px-4 pt-3 pb-1 text-sm focus:outline-none resize-none placeholder:text-muted-foreground/60 disabled:opacity-60"
                />
                <div className="flex items-center justify-end gap-3 px-3 pb-2">
                  <button
                    type="button"
                    onClick={() => submit()}
                    disabled={isPending || draft.trim().length === 0}
                    aria-label="Send"
                    className="glassy-send h-7 w-7 inline-flex items-center justify-center rounded-full cursor-pointer"
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

const RUNTIME_DISPLAY_NAME: Record<KnownCli, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

function RuntimeMismatchBanner({
  mismatch,
}: {
  mismatch: { pinned_cli: KnownCli; current_cli: KnownCli };
}) {
  const pinned = RUNTIME_DISPLAY_NAME[mismatch.pinned_cli];
  const current = RUNTIME_DISPLAY_NAME[mismatch.current_cli];
  return (
    <div className="mx-6 mt-3 rounded-lg border border-status-review/40 bg-status-review/5 px-3 py-2 text-xs text-foreground/80">
      <span className="font-medium">{pinned}</span> is running this conversation
      because that&apos;s the runtime it started on. Your agent is now set to{" "}
      <span className="font-medium">{current}</span> — to use it, start a{" "}
      <Link
        href="/chat?new=1"
        className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
      >
        new chat
      </Link>
      .
    </div>
  );
}

function HeroEmptyChat({
  onSubmit,
  draft,
  setDraft,
  onboarding,
}: {
  onSubmit: (text?: string) => void;
  draft: string;
  setDraft: (s: string) => void;
  onboarding: boolean;
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
            <Avatar
              initial={initial}
              kind={teamAgent.hierarchy}
              label={teamAgent.display_name ?? teamAgent.name}
              specialization={teamAgent.specialization}
              size={56}
            />
          ) : (
            <Avatar initial="?" kind="team" label="Team agent" size={56} />
          )}
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">
            How can your team help you today?
          </h1>
        </div>

        {/* Centered input. The composer sits in the middle of the page
            instead of the bottom-stuck position used during a real
            conversation — same shape as Notion's "Do anything with AI..." */}
        <div className="rounded-xl glass-surface focus-within:ring-2 focus-within:ring-ring transition-shadow">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask your team agent…"
            rows={3}
            autoFocus
            className="w-full bg-transparent px-4 pt-3 pb-2 text-sm focus:outline-none resize-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center justify-end gap-3 px-3 pb-2">
            <button
              type="button"
              onClick={() => onSubmit()}
              disabled={draft.trim().length === 0}
              aria-label="Send"
              className="glassy-send h-7 w-7 inline-flex items-center justify-center rounded-full cursor-pointer"
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

function HeroSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xs text-muted-foreground/70 mb-2 px-1">{title}</h2>
      {children}
    </div>
  );
}

/**
 * System-trigger annotation. Visually matches the `ToolStepList` row
 * shape (small icon-square + compact muted text) so the user reads it
 * as a system event — like a tool call — rather than a chat
 * participant. Currently sourced from `<system-wake>` intents produced
 * by the watch_tasks DB trigger.
 */
function SystemPill({ content }: { content: string }) {
  // The server-extracted wake summary may start with a "Wake reason: <text>"
  // line followed by a blank line. Split it out so the task summary stays
  // the headline; otherwise we'd stack "Watch fired — Wake reason:" and
  // demote the actual completion list into the body.
  const { reason, summary } = splitWakeReason(content);
  const lines = summary.split("\n");
  const headline = lines[0] ?? "";
  const body = lines.slice(1).join("\n").trim();
  return (
    <div className="flex w-full justify-start mt-4">
      <div className="w-7 mr-2 shrink-0" />
      <div className="flex-1 min-w-0 text-[11px] text-muted-foreground/80">
        <div className="flex items-center gap-1.5 leading-4">
          <span className="shrink-0 inline-flex items-center justify-center h-4 w-4 rounded bg-secondary/60 opacity-90">
            <Bell className="h-2.5 w-2.5" />
          </span>
          <span className="text-foreground/70 shrink-0">Watch fired</span>
          {headline ? (
            <span className="text-muted-foreground/60 truncate min-w-0">— {headline}</span>
          ) : null}
        </div>
        {reason ? (
          <div className="mt-0.5 ml-[22px] italic text-muted-foreground/60">
            {reason}
          </div>
        ) : null}
        {body ? (
          <div className="mt-0.5 ml-[22px] whitespace-pre-wrap leading-4 text-muted-foreground/65">
            {body}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Pull an optional `Wake reason: <text>` prefix off the summary so the UI
 * can render it as a subtitle. Returns the rest of the summary unchanged
 * (matches the server's emission contract — see `extractWakeSummary` in
 * `packages/api/src/routes/chat.ts`).
 */
export function splitWakeReason(content: string): { reason?: string; summary: string } {
  const m = content.match(/^Wake reason: ([^\n]+)\n+/);
  if (!m) return { summary: content };
  return { reason: m[1]!.trim(), summary: content.slice(m[0].length) };
}

function Bubble({
  message,
  showSuggestions,
  onSuggest,
  teamAgent,
  isFirstInGroup,
  steps,
  tree,
}: {
  message: ChatMessage;
  showSuggestions?: boolean;
  onSuggest?: (label: string) => void;
  teamAgent: {
    initial: string;
    kind: HierarchyLevel;
    label?: string;
    specialization?: string;
  };
  isFirstInGroup: boolean;
  /** Completed turn's working trace, rendered as a collapsed disclosure above the reply. */
  steps?: ChatStreamStep[];
  /** Tree of spawned IC sessions, for inline transcripts in the disclosure (tree mode only). */
  tree?: ChatStreamTree;
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
            <Avatar
              initial={teamAgent.initial}
              kind={teamAgent.kind}
              label={teamAgent.label}
              specialization={teamAgent.specialization}
              size={28}
            />
          ) : null}
        </div>
      ) : null}
      <div
        className={cn(
          "flex flex-col min-w-0",
          isUser ? "items-end max-w-[68%]" : "items-start max-w-[78%]",
        )}
      >
        {isUser ? (
          <div className="rounded-2xl px-3.5 py-2 glass-bubble-user">
            <div className="text-sm whitespace-pre-wrap">{message.content}</div>
          </div>
        ) : (
          <>
            {/* Collapsed working trace, above the reply — the tool steps ran
                before the agent produced its answer (chrono order), and
                they no longer vanish when the turn completes. */}
            {steps ? (
              <WorkedDisclosure
                steps={steps}
                tree={tree}
                parentSessionId={message.session_id}
              />
            ) : null}
            <div className="py-1 text-sm leading-6 text-foreground/90">
              <ChatMarkdown content={message.content} inverted={false} />
            </div>
          </>
        )}
        {!isUser ? (
          <>
            {refIds.length > 0 ? <ReferenceCards ids={refIds} /> : null}
            {message.repo_cards && message.repo_cards.length > 0 ? (
              <RepoCards cards={message.repo_cards} />
            ) : null}
            {message.open_view ? <OpenViewCta open_view={message.open_view} /> : null}
          </>
        ) : null}
        {suggestions.length > 0 && onSuggest ? (
          <SuggestedActions actions={suggestions} onPick={onSuggest} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A finished turn's working trace, collapsed into a drop-down above the
 * reply. Expands to the same `ToolStepList` the live working box uses, so
 * live and completed traces read identically (category icons, inline IC
 * transcripts, session_search recall blocks). Renders nothing when the turn
 * made no tool calls.
 */
function WorkedDisclosure({
  steps,
  tree,
  parentSessionId,
}: {
  steps: ChatStreamStep[];
  tree?: ChatStreamTree;
  parentSessionId?: string;
}) {
  const toolSteps = steps.filter(
    (s) => s.kind === "tool_call" || s.kind === "tool_result",
  );
  if (toolSteps.length === 0) return null;
  const count = toolSteps.filter((s) => s.kind === "tool_call").length || toolSteps.length;
  return (
    <details className="group w-full mb-1">
      <summary className="flex items-center gap-1.5 cursor-pointer select-none list-none text-[10px] uppercase tracking-wide text-muted-foreground/45 hover:text-muted-foreground/70 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
        Worked · {count} step{count === 1 ? "" : "s"}
      </summary>
      <div className="mt-1.5">
        <ToolStepList
          steps={toolSteps}
          totalSteps={toolSteps.length}
          tree={tree}
          parentSessionId={parentSessionId}
        />
      </div>
    </details>
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
    <div className="mt-3 flex flex-wrap gap-1.5">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={() => onPick(a.prompt ?? a.label)}
          title={a.prompt && a.prompt !== a.label ? a.prompt : undefined}
          className="text-left rounded-full border border-border/50 bg-transparent hover:bg-secondary/45 hover:border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

const SOURCE_BADGE_CLASS: Record<NonNullable<ChatRepoCard["source"]>, string> = {
  learned: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  trending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  community: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  github: "bg-muted text-muted-foreground border-border",
};

const SOURCE_LABEL: Record<NonNullable<ChatRepoCard["source"]>, string> = {
  learned: "Learned",
  trending: "Trending",
  community: "Community",
  github: "GitHub",
};

function RepoCards({ cards }: { cards: ChatRepoCard[] }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {cards.map((card) => (
        <RepoCardRow key={card.repo_url} card={card} />
      ))}
    </div>
  );
}

/**
 * Single repo row from a find_repo result. The Try button is the
 * "agentic action" loop closed without the agent — click triggers a
 * use_repo sandbox run with a sensible default goal, then the button
 * swaps to a deep-link into the playground (the run detail page).
 */
function RepoCardRow({ card }: { card: ChatRepoCard }) {
  const [watchUrl, setWatchUrl] = useState<string | null>(null);
  const tryRun = useMutation({
    mutationFn: () =>
      api.capabilities.use({
        repo_url: card.repo_url,
        goal: defaultTryGoal({
          owner: card.owner,
          name: card.name,
          description: card.description,
        }),
      }),
    onSuccess: (res) => setWatchUrl(res.watch_url),
  });

  return (
    <div className="rounded-lg border border-border/40 bg-card hover:border-foreground/30 px-3 py-2 transition-colors">
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href={card.repo_url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-foreground hover:underline"
        >
          {card.owner}/{card.name}
        </Link>
        {typeof card.stars === "number" ? (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-amber-300 tabular-nums">
            <Star className="h-3 w-3 fill-current" />
            {formatStars(card.stars)}
          </span>
        ) : null}
        {card.language ? (
          <span className="text-[11px] text-muted-foreground">{card.language}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {card.source ? (
            <span
              className={cn(
                "text-[10px] uppercase tracking-wider rounded border px-1.5 py-0.5",
                SOURCE_BADGE_CLASS[card.source],
              )}
            >
              {SOURCE_LABEL[card.source]}
            </span>
          ) : null}
          {watchUrl ? (
            <Link
              href={watchUrl}
              className="inline-flex items-center gap-1 rounded-md bg-foreground text-background px-2.5 py-1 text-[11px] font-medium hover:opacity-90 transition-opacity"
            >
              Open playground
              <ArrowRight className="h-3 w-3" />
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => tryRun.mutate()}
              disabled={tryRun.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-transparent hover:bg-secondary hover:border-foreground/30 px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors disabled:opacity-50"
              title={`Try ${card.owner}/${card.name} in a sandbox`}
            >
              {tryRun.isPending ? "Starting…" : "Try"}
            </button>
          )}
        </div>
      </div>
      {card.description ? (
        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{card.description}</p>
      ) : null}
      {tryRun.error ? (
        <p className="mt-1 text-[11px] text-red-500">
          {tryRun.error instanceof Error ? tryRun.error.message : "Couldn't start the sandbox."}
        </p>
      ) : null}
    </div>
  );
}

function OpenViewCta({ open_view }: { open_view: { path: string; label?: string } }) {
  return (
    <Link
      href={open_view.path}
      className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-transparent px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/45 transition-colors cursor-pointer"
    >
      {open_view.label ?? "Open this"}
      <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

function Thinking({
  steps,
  teamAgent,
  tree,
  rootSessionId,
}: {
  steps: ChatStreamStep[];
  teamAgent: {
    initial: string;
    kind: HierarchyLevel;
    label?: string;
    specialization?: string;
  };
  tree?: ChatStreamTree;
  rootSessionId?: string;
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
  // Keep the working trace to the latest six moves. Anything older
  // collapses into the "+N earlier moves" row in ToolStepList. Tree
  // mode keeps the full list visible so the Nth create_task tool_call
  // still aligns with the Nth child in tree.children[parentSessionId]
  // (slicing would drop early calls and misalign IC blocks); IC nesting
  // is the value-add of tree mode so showing every step is correct.
  const recentTools = tree ? toolSteps : toolSteps.slice(-6);
  const hasWorkingText = streamingText.trim().length > 0;

  return (
    <div className="flex w-full justify-start mt-4">
      <div className="w-7 mr-2 shrink-0 flex justify-center">
        <Avatar
          initial={teamAgent.initial}
          kind={teamAgent.kind}
          label={teamAgent.label}
          specialization={teamAgent.specialization}
          size={28}
        />
      </div>
      <div className="max-w-[78%] min-w-0 py-1">
        {/* Working box on top — the tool steps stream in as the agent works,
            and the reply text renders below them (chrono order, ChatGPT
            shape). When the turn completes this whole block is replaced by
            the agent Bubble, which re-renders the same steps as a collapsed
            WorkedDisclosure above its reply. */}
        {recentTools.length > 0 ? (
          <div className="mb-3">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/45">
              Working
            </div>
            <ToolStepList
              steps={recentTools}
              totalSteps={toolSteps.length}
              tree={tree}
              parentSessionId={rootSessionId}
            />
          </div>
        ) : null}
        {hasWorkingText ? (
          <div className="text-sm leading-6 text-foreground/90">
            <ChatMarkdown content={streamingText} />
          </div>
        ) : (
          <div className="pl-3">
            <ChatLoader compact />
          </div>
        )}
      </div>
    </div>
  );
}
