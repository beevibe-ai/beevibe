"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowRight, MessageSquare, RotateCcw, Send, Sparkles } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { useChat, type ChatMessage } from "@/lib/hooks/use-chat";
import { useChatStream, type ChatStreamStep } from "@/lib/chat-stream";
import { useMe } from "@/lib/hooks/use-me";
import { sessionHref, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ReferenceCards } from "@/components/chat/reference-cards";

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
  const { messages, send, reset, isPending, error, pendingSessionId } = useChat();
  const liveSteps = useChatStream(pendingSessionId);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
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
          Set <span className="font-mono">NEXT_PUBLIC_BV_API_URL</span> +{" "}
          <span className="font-mono">NEXT_PUBLIC_BV_USER_KEY</span> to start chatting with your team
          agent.
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
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-6 pt-6 pb-3 border-b border-border/60 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Chat with your team agent</h1>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
            Ask the team agent to do things — mint tasks, query the fleet, brief you on a project.
            It has full hierarchy tool access during the turn.
          </p>
        </div>
        {messages.length > 0 ? (
          <button
            type="button"
            onClick={reset}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw className="h-3 w-3" />
            New conversation
          </button>
        ) : null}
      </header>

      <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.length === 0 ? (
            <EmptyHint
              onPick={(s) => submit(s)}
              disabled={isPending}
              onboarding={isOnboardingChat}
            />
          ) : (
            messages.map((m) => <Bubble key={m.id} message={m} />)
          )}
          {isPending ? <Thinking steps={liveSteps} /> : null}
          {error ? (
            <div className="rounded-lg border border-status-failed/40 bg-status-failed/5 p-3 text-xs">
              <div className="flex items-center gap-1.5 text-status-failed font-medium mb-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                Couldn&apos;t reach the agent
              </div>
              <div className="text-muted-foreground">{error.message}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border/60 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask your team agent…  (Enter to send, Shift+Enter for newline)"
            rows={2}
            disabled={isPending}
            className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => submit()}
            disabled={isPending || draft.trim().length === 0}
            aria-label="Send"
            className="h-9 w-9 inline-flex items-center justify-center rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  // Server now supplies view_refs per turn; fall back to empty if missing.
  const refIds = !isUser ? message.view_refs ?? [] : [];
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-secondary text-foreground border border-border",
        )}
      >
        {message.content}
        {refIds.length > 0 ? <ReferenceCards ids={refIds} /> : null}
        {message.open_view ? <OpenViewCta open_view={message.open_view} /> : null}
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

function Thinking({ steps }: { steps: ChatStreamStep[] }) {
  // Surface only tool steps; the final summary arrives via the synchronous
  // POST /chat response (so it shows as a regular agent bubble, not here).
  const visible = steps.filter((s) => s.kind === "tool_call" || s.kind === "tool_result");
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-secondary text-foreground border border-border">
        <div className="flex items-center gap-2 text-muted-foreground italic">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:200ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:400ms]" />
          </span>
          <span>thinking…</span>
          {visible.length > 0 ? (
            <span className="text-[10px] tabular-nums opacity-70 ml-auto">
              {visible.length} step{visible.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {visible.length > 0 ? (
          <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground/90">
            {visible.slice(-6).map((s) => (
              <li key={s.event_id} className="flex items-baseline gap-1.5 truncate">
                {s.tool_name ? (
                  <span className="font-mono text-foreground/80">{s.tool_name}</span>
                ) : (
                  <span className="font-mono text-foreground/60">{s.kind}</span>
                )}
                <span className="text-muted-foreground truncate">{s.content}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function EmptyHint({
  onPick,
  disabled,
  onboarding,
}: {
  onPick: (text: string) => void;
  disabled: boolean;
  onboarding?: boolean;
}) {
  const suggestions = onboarding ? ONBOARDING_PROMPT_SUGGESTIONS : PROMPT_SUGGESTIONS;
  return (
    <div className="text-sm text-muted-foreground text-center pt-12">
      <MessageSquare className="h-7 w-7 mx-auto mb-3 text-muted-foreground/50" />
      <div className="mb-1 text-foreground font-medium text-base">
        {onboarding ? "Start the conversation" : "How can your team agent help?"}
      </div>
      <div className="mb-6 text-xs text-muted-foreground/80 max-w-md mx-auto">
        {onboarding
          ? "Your team agent has questions for you. Pick a starter or just say hi — it'll save what it learns to its memory live."
          : "Mint tasks, query the fleet, brief you on a project. Click a prompt to start, or type your own below."}
      </div>
      <div
        className={cn(
          "grid gap-2 max-w-2xl mx-auto text-left",
          onboarding ? "sm:grid-cols-1" : "sm:grid-cols-2",
        )}
      >
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            disabled={disabled}
            className="rounded-md border border-border bg-card hover:bg-secondary hover:border-foreground/30 px-3 py-2.5 text-sm text-foreground transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-start gap-2"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
            <span>{s}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
