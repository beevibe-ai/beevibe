import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Check,
  ChevronRight,
  Download,
  Loader2,
  Repeat,
  XCircle,
} from "lucide-react";
import { BriefingComposer } from "@/components/sessions/briefing-composer";
import { Transcript } from "@/components/sessions/transcript";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { HierChip } from "@/components/hier-chip";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { findSessionById } from "@/lib/fixtures/sessions";
import { formatRelativeTime } from "@/lib/format";

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  const session = findSessionById(params.id);
  return { title: session ? session.intent : "Session" };
}

const STATUS_AVATAR = {
  succeeded: { Icon: Check, bg: "bg-status-done/10 text-status-done" },
  running: { Icon: Loader2, bg: "bg-status-running/10 text-status-running" },
  failed: { Icon: XCircle, bg: "bg-status-failed/10 text-status-failed" },
  cancelled: { Icon: XCircle, bg: "bg-secondary text-muted-foreground" },
} as const;

export default function SessionDetailPage({ params }: { params: { id: string } }) {
  const session = findSessionById(params.id);
  if (!session) notFound();

  const avatar = STATUS_AVATAR[session.status];
  const Icon = avatar.Icon;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="text-xs text-muted-foreground mb-4 flex items-center gap-1.5">
          <Link href="/tasks" className="hover:text-foreground transition-colors">
            Tasks
          </Link>
          <ChevronRight className="h-3 w-3" />
          <Link href={`/tasks/${session.task_id}`} className="hover:text-foreground transition-colors">
            {session.task_short_id} · {session.task_title}
          </Link>
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground font-mono">{session.short_id}</span>
        </div>

        <header className="mb-6">
          <div className="flex items-start gap-3">
            <div
              className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${avatar.bg}`}
            >
              <Icon
                className={
                  session.status === "running" ? "animate-spin-slow h-5 w-5" : "h-5 w-5"
                }
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-base font-semibold leading-tight">{session.intent}</h1>
                <SessionStatusPill status={session.status} />
              </div>
              <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                <Link
                  href={`/agents/${session.agent_id}`}
                  className="font-mono text-foreground hover:underline"
                >
                  {session.agent_label}
                </Link>
                <HierChip hier={session.agent_hierarchy} />
                <span className="text-border">·</span>
                <span>
                  type <span className="font-mono text-foreground">{session.type}</span>
                </span>
                <span className="text-border">·</span>
                <span>
                  started {formatRelativeTime(session.started_at)}, {session.duration_label}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium hover:bg-secondary cursor-pointer transition-colors text-muted-foreground hover:text-foreground">
                <Repeat className="h-3.5 w-3.5" />
                Re-run
              </button>
              <button
                aria-label="Download session log"
                className="h-8 w-8 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
              >
                <Download className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <BriefingComposer briefing={session.briefing} />

        <Transcript entries={session.transcript} />

        <div className="mt-8 pt-4 border-t border-border flex items-center gap-3 text-xs text-muted-foreground">
          <ClickToCopyId id={session.id.replace(/^[a-z]+_/, "")} />
          <span className="text-border">·</span>
          <span>
            Started <span className="text-foreground">{formatRelativeTime(session.started_at)}</span>
          </span>
          <span className="text-border">·</span>
          <Link href={`/tasks/${session.task_id}`} className="hover:text-foreground transition-colors">
            Parent task {session.task_short_id}
          </Link>
        </div>
      </div>
    </div>
  );
}
