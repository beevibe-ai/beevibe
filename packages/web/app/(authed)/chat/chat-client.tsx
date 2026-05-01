"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, MessageSquare, RotateCcw, Send } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { useChat, type ChatMessage } from "@/lib/hooks/use-chat";
import { sessionHref } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ChatClient() {
  const [draft, setDraft] = useState("");
  const { messages, send, reset, isPending, error } = useChat();
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isPending]);

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

  const submit = () => {
    send(draft);
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
          <h1 className="text-base font-semibold">Chat with your team agent</h1>
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
            <EmptyHint />
          ) : (
            messages.map((m) => <Bubble key={m.id} message={m} />)
          )}
          {isPending ? <Thinking /> : null}
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
            onClick={submit}
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
        {message.session_id ? (
          <div className="mt-1.5 text-[10px] font-mono opacity-70">
            <Link
              href={sessionHref(shortSessionId(message.session_id))}
              className="hover:underline"
            >
              session {shortSessionId(message.session_id)}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex justify-start">
      <div className="rounded-lg px-3 py-2 text-sm bg-secondary text-muted-foreground border border-border italic">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:200ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:400ms]" />
        </span>
        <span className="ml-2">thinking…</span>
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="text-sm text-muted-foreground text-center pt-12">
      <MessageSquare className="h-6 w-6 mx-auto mb-2 text-muted-foreground/60" />
      <div className="mb-1 text-foreground font-medium">Start the conversation</div>
      <div>
        Try: <em>&ldquo;Create a task to refactor the billing module.&rdquo;</em>
      </div>
    </div>
  );
}

function shortSessionId(sid: string): string {
  return sid.replace(/^[a-z]+_/, "").slice(0, 6);
}
