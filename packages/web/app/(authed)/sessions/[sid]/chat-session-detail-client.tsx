"use client";

import Link from "next/link";
import { ArrowLeft, ChevronRight, Terminal, Wrench } from "lucide-react";
import { useConversation } from "@/lib/hooks/use-sessions";
import { DetailQuery } from "@/components/detail/detail-query";
import { DetailShell } from "@/components/detail/detail-shell";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { FooterField } from "@/components/detail/footer-field";
import { ChatMarkdown } from "@/components/chat/markdown";
import { HierChip } from "@/components/hier-chip";
import { Avatar } from "@/components/avatar";
import { UsagePanel } from "@/components/sessions/usage-panel";
import type {
  ConversationDisplay,
  SessionDisplay,
  TranscriptEntry,
} from "@/lib/types/sessions";
import { cn } from "@/lib/utils";

/**
 * Detail view for a chat conversation (and any non-task session). A chat is
 * a chain of per-turn sessions sharing one `conversation_id`; this page
 * collapses them into one continuous thread — each turn rendered as the
 * user's message, the agent's tool steps, then the agent's reply, in
 * chronological order. Non-chat sessions (mesh_ask, blocker, negotiate)
 * resolve to a single turn and render unchanged.
 *
 * Task-spawned sessions have their own task-scoped detail page at
 * `/tasks/[id]/sessions/[sid]`, so we redirect those out.
 */
export function ChatSessionDetailClient({ sessionShortId }: { sessionShortId: string }) {
  const query = useConversation(sessionShortId);

  const nav = <BackToChat />;

  return (
    <DetailQuery
      query={query}
      nav={nav}
      icon={Terminal}
      entity="session"
      entityId={sessionShortId}
      skeleton={
        <>
          <Skeleton className="h-14 w-full mb-6" />
          <Skeleton className="h-32 w-full mb-5 rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </>
      }
    >
      {(data) =>
        // Task-typed sessions belong on the task-scoped detail page; redirect
        // via a visible link rather than auto-routing so the user keeps control.
        data.type === "task" && data.task_id ? (
          <DetailShell nav={nav}>
            <EmptyState
              icon={Terminal}
              title="This is a task session"
              description="Open the task-scoped session view for full context."
              cta={{
                href: `/tasks/${data.task_id}/sessions/${data.short_id}`,
                label: "Open task session",
              }}
            />
          </DetailShell>
        ) : (
          <DetailShell nav={nav}>
            <ConversationBody conversation={data} />
          </DetailShell>
        )
      }
    </DetailQuery>
  );
}

function BackToChat() {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-muted-foreground mb-4">
      <Link
        href="/chat"
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to chat
      </Link>
    </nav>
  );
}

function ConversationBody({ conversation }: { conversation: ConversationDisplay }) {
  const { turns, usage } = conversation;
  const multiTurn = turns.length > 1;
  const lastTurn = turns[turns.length - 1];

  return (
    <>
      <header className="mb-6">
        <div className="flex items-start gap-3">
          <Avatar
            initial={conversation.agent_label.charAt(0).toUpperCase()}
            kind={conversation.agent_hierarchy}
            label={conversation.agent_label}
            size={40}
            presence={conversation.status === "running" ? "running" : "idle"}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-base font-semibold tracking-tight leading-tight">
                {multiTurn ? "Conversation" : "One turn"}
              </h1>
              <SessionStatusPill status={conversation.status} />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="text-foreground/85">{conversation.agent_label}</span>
              <HierChip hier={conversation.agent_hierarchy} />
              {multiTurn ? (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="tabular-nums">{turns.length} turns</span>
                </>
              ) : null}
              <span className="text-muted-foreground/50">·</span>
              <span className="text-foreground/70">{conversation.type}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="space-y-6">
        {turns.map((turn) => (
          <ChatTurn key={turn.id} turn={turn} />
        ))}
      </div>

      {usage ? <UsagePanel usage={usage} /> : null}

      <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
        <FooterField label="Conversation ID">
          <ClickToCopyId id={conversation.conversation_id} />
        </FooterField>
        {lastTurn?.cli_session ? (
          <FooterField label="CLI session" truncate>
            <span className="font-mono">{lastTurn.cli_session}</span>
          </FooterField>
        ) : null}
        {lastTurn?.worktree ? (
          <FooterField label="Worktree" truncate>
            <span className="font-mono">{lastTurn.worktree}</span>
          </FooterField>
        ) : null}
        <FooterField label="Type">{conversation.type}</FooterField>
      </footer>
    </>
  );
}

/**
 * One turn of the conversation, in chronological order:
 *   1. the user's message (intent),
 *   2. the agent's tool steps — collapsed by default, placed ABOVE the
 *      reply because the tools ran before the agent produced its answer,
 *   3. the agent's final visible reply.
 */
function ChatTurn({ turn }: { turn: SessionDisplay }) {
  // Pull the agent's final visible response: prefer the `summary` event (the
  // persisted final after directive-stripping), fall back to the last
  // `agent` text block.
  const summary = [...turn.transcript].reverse().find((e) => e.kind === "summary");
  const lastAgent = [...turn.transcript].reverse().find((e) => e.kind === "agent");
  const finalResponse = summary?.content ?? lastAgent?.content ?? "";

  const toolSteps = turn.transcript.filter(
    (e) => e.kind === "tool_call" || e.kind === "tool_result",
  );

  return (
    <div>
      {/* User intent — the message that started this turn */}
      <div className="mb-2 flex justify-end">
        <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-primary text-primary-foreground">
          {turn.intent}
        </div>
      </div>

      {/* Tool steps — collapsed, above the reply to reflect the time order */}
      {toolSteps.length > 0 ? (
        <details className="group mb-2">
          <summary className="flex items-center gap-1.5 cursor-pointer select-none list-none text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            <Wrench className="h-3 w-3" />
            {toolSteps.length} tool {toolSteps.length === 1 ? "step" : "steps"}
          </summary>
          <div className="mt-2">
            <ToolTranscript entries={toolSteps} />
          </div>
        </details>
      ) : null}

      {/* Agent's final visible response */}
      {finalResponse ? (
        <div className="flex flex-col items-start">
          <div className="max-w-[80%] rounded-lg px-3 py-2 bg-secondary text-foreground border border-border">
            <ChatMarkdown content={finalResponse} />
          </div>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic">
          (no response — turn {turn.status})
        </div>
      )}
    </div>
  );
}

function ToolTranscript({ entries }: { entries: TranscriptEntry[] }) {
  return (
    <ol className="rounded-lg border border-border bg-card/40 divide-y divide-border/60">
      {entries.map((entry, i) => (
        <li
          key={`${entry.timestamp}-${i}`}
          className="px-3 py-2 flex items-baseline gap-2 text-xs"
        >
          <span
            className={cn(
              "font-mono font-medium shrink-0",
              entry.kind === "tool_call" ? "text-foreground/80" : "text-muted-foreground/80",
            )}
          >
            {entry.tool_name ?? entry.kind}
          </span>
          <span className="text-muted-foreground truncate flex-1 min-w-0">
            {entry.content}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground/60 shrink-0">
            {entry.kind}
          </span>
        </li>
      ))}
    </ol>
  );
}
