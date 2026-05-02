"use client";

import Link from "next/link";
import { Bot, ListChecks, Terminal, type LucideIcon } from "lucide-react";
import { useAgent } from "@/lib/hooks/use-agents";
import { useSession } from "@/lib/hooks/use-sessions";
import { useTask } from "@/lib/hooks/use-tasks";
import { sessionHref, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ReferenceCards({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {ids.map((id) => (
        <ReferenceCard key={id} id={id} />
      ))}
    </div>
  );
}

function ReferenceCard({ id }: { id: string }) {
  if (id.startsWith("task_")) return <TaskRefCard id={id} />;
  if (id.startsWith("agent_")) return <AgentRefCard id={id} />;
  if (id.startsWith("sess_")) return <SessionRefCard id={id} />;
  return null;
}

function TaskRefCard({ id }: { id: string }) {
  const { data, isLoading } = useTask(id);
  return (
    <CardShell href={`/tasks/${encodeURIComponent(id)}`} icon={ListChecks}>
      {isLoading ? (
        <CardLoading label="task" />
      ) : data ? (
        <>
          <CardTitle>{data.title}</CardTitle>
          <CardMeta>
            <StatusDot status={data.status} />
            <span className="capitalize">{data.status.replace("_", " ")}</span>
            <span className="opacity-60">·</span>
            <span className="font-mono">{shortId(id)}</span>
          </CardMeta>
        </>
      ) : (
        <CardMissing label="task" id={id} />
      )}
    </CardShell>
  );
}

function AgentRefCard({ id }: { id: string }) {
  const { data, isLoading } = useAgent(id);
  return (
    <CardShell href={`/agents/${encodeURIComponent(id)}`} icon={Bot}>
      {isLoading ? (
        <CardLoading label="agent" />
      ) : data ? (
        <>
          <CardTitle>{data.display_name || data.name}</CardTitle>
          <CardMeta>
            <span className="capitalize">{data.hierarchy}</span>
            <span className="opacity-60">·</span>
            <span className="font-mono">{shortId(id)}</span>
          </CardMeta>
        </>
      ) : (
        <CardMissing label="agent" id={id} />
      )}
    </CardShell>
  );
}

function SessionRefCard({ id }: { id: string }) {
  const sid = id.replace(/^sess_/, "").slice(0, 6);
  const { data, isLoading } = useSession(sid);
  return (
    <CardShell href={data ? sessionHref(data.id, data.task_id) : "#"} icon={Terminal}>
      {isLoading ? (
        <CardLoading label="session" />
      ) : data ? (
        <>
          <CardTitle>
            <span className="text-muted-foreground/80">{data.agent_label} · </span>
            {data.task_title}
          </CardTitle>
          <CardMeta>
            <StatusDot status={data.status} />
            <span className="capitalize">{data.status}</span>
            <span className="opacity-60">·</span>
            <span className="font-mono">{shortId(id)}</span>
          </CardMeta>
        </>
      ) : (
        <CardMissing label="session" id={id} />
      )}
    </CardShell>
  );
}

function CardShell({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-start gap-2.5 rounded-md border border-border bg-background/60 hover:bg-background hover:border-foreground/30 px-2.5 py-2 text-xs transition-colors group"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground group-hover:text-foreground transition-colors" />
      <div className="min-w-0 flex-1 space-y-0.5">{children}</div>
    </Link>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <div className="font-medium text-foreground truncate">{children}</div>;
}

function CardMeta({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">{children}</div>
  );
}

function CardLoading({ label }: { label: string }) {
  return <div className="text-[11px] text-muted-foreground italic">loading {label}…</div>;
}

function CardMissing({ label, id }: { label: string; id: string }) {
  return (
    <div className="text-[11px] text-muted-foreground">
      {label} <span className="font-mono">{shortId(id)}</span> not found
    </div>
  );
}

const STATUS_DOT: Record<string, string> = {
  pending: "bg-status-pending",
  in_progress: "bg-status-running",
  running: "bg-status-running",
  done: "bg-status-done",
  succeeded: "bg-status-done",
  blocked: "bg-status-blocked",
  failed: "bg-status-failed",
  cancelled: "bg-muted-foreground/40",
  review: "bg-status-review",
  revision: "bg-status-review",
};

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_DOT[status] ?? "bg-muted-foreground/40")}
    />
  );
}
