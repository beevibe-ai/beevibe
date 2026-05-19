"use client";

import Link from "next/link";
import { AlertTriangle, ArrowLeft, Terminal, Wrench } from "lucide-react";
import { useSession } from "@/lib/hooks/use-sessions";
import { isApiConfigured } from "@/lib/api/config";
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
import type { SessionDisplay, TranscriptEntry } from "@/lib/types/sessions";
import { cn } from "@/lib/utils";

/**
 * Per-session detail for chat (and any non-task session). Shows the
 * single turn as a chat-shaped layout — user intent + agent reply with
 * markdown — plus the tool transcript collapsed below for debugging.
 *
 * Task-spawned sessions have their own task-scoped detail page at
 * `/tasks/[id]/sessions/[sid]`. This route handles everything else:
 * chat, mesh_ask, blocker, negotiate.
 */
export function ChatSessionDetailClient({ sessionShortId }: { sessionShortId: string }) {
  const { data, isLoading, isError } = useSession(sessionShortId);

  const nav = <BackToChat />;

  if (!isApiConfigured) {
    return (
      <DetailShell nav={nav}>
        <EmptyState
          icon={Terminal}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL and run the API server to load this session."
        />
      </DetailShell>
    );
  }

  if (isLoading) {
    return (
      <DetailShell nav={nav}>
        <Skeleton className="h-14 w-full mb-6" />
        <Skeleton className="h-32 w-full mb-5 rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </DetailShell>
    );
  }

  if (isError || !data) {
    return (
      <DetailShell nav={nav}>
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load session"
          description={`Session ${sessionShortId} could not be fetched.`}
        />
      </DetailShell>
    );
  }

  // Task-typed sessions belong on the task-scoped detail page; redirect via a
  // visible link rather than auto-routing so the user keeps control.
  if (data.type === "task" && data.task_id) {
    return (
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
    );
  }

  return (
    <DetailShell nav={nav}>
      <ChatSessionBody session={data} />
    </DetailShell>
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

function ChatSessionBody({ session }: { session: SessionDisplay }) {
  // Pull the agent's final visible response out of the transcript: prefer
  // the `summary` event (the persisted final after directive-stripping),
  // fall back to the last `agent` text block.
  const summary = [...session.transcript].reverse().find((e) => e.kind === "summary");
  const lastAgent = [...session.transcript].reverse().find((e) => e.kind === "agent");
  const finalResponse = summary?.content ?? lastAgent?.content ?? "";

  // Tool steps for the collapsible transcript section below the bubbles.
  const toolSteps = session.transcript.filter(
    (e) => e.kind === "tool_call" || e.kind === "tool_result",
  );

  return (
    <>
      <header className="mb-6">
        <div className="flex items-start gap-3">
          <Avatar
            initial={session.agent_label.charAt(0).toUpperCase()}
            kind={session.agent_hierarchy}
            label={session.agent_label}
            size={40}
            presence={session.status === "running" ? "running" : "idle"}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-base font-semibold tracking-tight leading-tight">One turn</h1>
              <SessionStatusPill status={session.status} />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="text-foreground/85">{session.agent_label}</span>
              <HierChip hier={session.agent_hierarchy} />
              <span className="text-muted-foreground/50">·</span>
              <span className="tabular-nums">{session.duration_label}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="text-foreground/70">{session.type}</span>
            </div>
          </div>
        </div>
      </header>

      {/* User intent — the message that started this turn */}
      <div className="mb-3 flex justify-end">
        <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-primary text-primary-foreground">
          {session.intent}
        </div>
      </div>

      {/* Agent's final visible response */}
      {finalResponse ? (
        <div className="mb-6 flex flex-col items-start">
          <div className="max-w-[80%] rounded-lg px-3 py-2 bg-secondary text-foreground border border-border">
            <ChatMarkdown content={finalResponse} />
          </div>
        </div>
      ) : (
        <div className="mb-6 text-xs text-muted-foreground italic">
          (no response — session {session.status})
        </div>
      )}

      {toolSteps.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Wrench className="h-3 w-3" />
            Tool transcript
            <span className="ml-1 tabular-nums text-muted-foreground/60">
              {toolSteps.length}
            </span>
          </h2>
          <ToolTranscript entries={toolSteps} />
        </section>
      ) : null}

      {session.usage ? <UsagePanel usage={session.usage} /> : null}

      <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
        <FooterField label="Session ID">
          <ClickToCopyId id={session.id} />
        </FooterField>
        {session.cli_session ? (
          <FooterField label="CLI session" truncate>
            <span className="font-mono">{session.cli_session}</span>
          </FooterField>
        ) : null}
        {session.worktree ? (
          <FooterField label="Worktree" truncate>
            <span className="font-mono">{session.worktree}</span>
          </FooterField>
        ) : null}
        <FooterField label="Type">{session.type}</FooterField>
      </footer>
    </>
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
