"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  ListChecks,
  MessageCircle,
  Network,
  PanelRightClose,
  PanelRightOpen,
  ShieldQuestion,
  Sparkles,
  Wrench,
} from "lucide-react";
import { api, type ActivityEntry } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { useCollapsible } from "@/lib/hooks/use-collapsible";
import { getLiveStatus, subscribeLiveStatus } from "@/lib/sse";
import { formatRelativeTime, sessionHref, shortId } from "@/lib/format";
import type { AgentDisplay } from "@/lib/types/agents";
import type { TaskListItem } from "@/lib/types/tasks";
import type { SessionType } from "@beevibe/core";
import { cn } from "@/lib/utils";

/**
 * Right-side rail on `/chat` showing what's happening across the
 * user's team in real time. Three sections — team roster, active
 * tasks, recent activity — each invalidated by the global SSE
 * pipeline so the panel stays live without polling. Built for the
 * demo: when the team agent spawns specialists, audience sees them
 * appear in the team roster; when one specialist asks another, both
 * sessions show up side-by-side in recent activity.
 */
export function LivePanel() {
  // Default collapsed: chat is the focal surface, the live panel is a
  // peek-when-needed thing. Keeping it expanded by default ate ~288px
  // of horizontal real estate every time someone opened /chat for a
  // quick reply. User toggle still wins (persisted).
  const [collapsed, toggleCollapsed] = useCollapsible("bv-livepanel-collapsed", true);
  if (!isApiConfigured) return null;

  if (collapsed) {
    return (
      <aside
        aria-label="Live panel (collapsed)"
        className="hidden lg:flex w-9 shrink-0 border-l border-border/60 bg-card/40 flex-col items-center pt-3"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand live panel"
          title="Expand live panel"
          className="h-7 w-7 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="hidden lg:flex w-72 shrink-0 border-l border-border/60 bg-card/40 flex-col overflow-hidden">
      <div className="flex items-center justify-between h-9 px-3 border-b border-border/60 shrink-0">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
          Live
        </span>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Collapse live panel"
          title="Collapse live panel"
          className="h-6 w-6 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-border/60">
        <TeamRoster />
        <ActiveWork />
        <RecentActivity />
      </div>
      <LiveStatusFooter />
    </aside>
  );
}

const LIVE_STATUS_LABELS = {
  live: {
    dot: "bg-status-running animate-pulse-breathe",
    label: "live · streams via SSE",
    title: undefined as string | undefined,
  },
  "polling-only": {
    dot: "bg-status-review",
    label: "polling every 3s",
    title: "SSE was buffered by the proxy. Updates still arrive every ~3s via polling.",
  },
  connecting: {
    dot: "bg-muted-foreground/60 animate-pulse",
    label: "connecting…",
    title: undefined as string | undefined,
  },
} as const;

function LiveStatusFooter() {
  const [status, setStatus] = useState(getLiveStatus());
  useEffect(() => subscribeLiveStatus(setStatus), []);
  const { dot, label, title } = LIVE_STATUS_LABELS[status];
  return (
    <footer
      className="border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground/80 flex items-center gap-1.5"
      title={title}
    >
      <span className={cn("inline-block h-1 w-1 rounded-full", dot)} />
      {label}
    </footer>
  );
}

// ── Section header ─────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  label,
  count,
  href,
}: {
  icon: typeof Bot;
  label: string;
  count?: number | string;
  href?: string;
}) {
  const inner = (
    <span className="flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-muted-foreground/80" />
      <span>{label}</span>
      {count !== undefined ? (
        <span className="tabular-nums text-muted-foreground/70">{count}</span>
      ) : null}
    </span>
  );
  return (
    <div className="px-3 pt-3 pb-2 text-[11px] font-medium text-foreground/80 uppercase tracking-wide flex items-center justify-between">
      {inner}
      {href ? (
        <Link href={href} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
          all →
        </Link>
      ) : null}
    </div>
  );
}

// ── Team roster ─────────────────────────────────────────────────────────

function TeamRoster() {
  const { data, isLoading } = useQuery<AgentDisplay[]>({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }) => api.agents.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 15_000,
  });

  const agents = data ?? [];

  return (
    <section className="pb-3">
      <SectionHeader icon={Bot} label="Your team" count={agents.length || undefined} href="/agents" />
      {isLoading ? (
        <RowSkeleton count={2} />
      ) : agents.length === 0 ? (
        <Hint icon={Sparkles}>No agents yet — your team agent will spawn specialists when you point it at a codebase.</Hint>
      ) : (
        <ul className="px-1">
          {agents.map((a) => (
            <li key={a.id}>
              <Link
                href={`/agents/${a.id}`}
                className="block px-2 py-1.5 mx-1 rounded hover:bg-secondary transition-colors"
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xs font-medium truncate flex-1 min-w-0">{a.name}</span>
                  <HierBadge hier={a.hierarchy} />
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground tabular-nums flex items-center gap-1.5">
                  <span>{a.sessions_count} sessions</span>
                  {a.facts_learned && a.facts_learned > 0 ? (
                    <>
                      <span className="text-muted-foreground/50">·</span>
                      <span>{a.facts_learned} facts</span>
                    </>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HierBadge({ hier }: { hier: AgentDisplay["hierarchy"] }) {
  return (
    <span
      className={cn(
        "shrink-0 px-1.5 py-px rounded text-[9px] font-mono uppercase tracking-wide",
        hier === "team" && "bg-hier-team/15 text-hier-team",
        hier === "org" && "bg-hier-org/15 text-hier-org",
        hier === "ic" && "bg-muted text-muted-foreground",
      )}
    >
      {hier}
    </span>
  );
}

// ── Active work ─────────────────────────────────────────────────────────

function ActiveWork() {
  // No "active" lifecycle on the backend — pull "in_progress" + filter
  // out terminal ones client-side. This catches everything we want
  // (in_progress, review) for the panel's purpose.
  const { data, isLoading } = useQuery<TaskListItem[]>({
    queryKey: queryKeys.tasks.list({}),
    queryFn: ({ signal }) => api.tasks.list({}, { signal }),
    enabled: isApiConfigured,
    staleTime: 10_000,
  });

  const tasks = (data ?? []).filter(
    (t) => t.status !== "done" && t.status !== "cancelled" && t.status !== "failed",
  );

  return (
    <section className="pb-3">
      <SectionHeader icon={ListChecks} label="Active work" count={tasks.length || undefined} href="/tasks" />
      {isLoading ? (
        <RowSkeleton count={2} />
      ) : tasks.length === 0 ? (
        <Hint icon={ListChecks}>No active tasks. Once an agent starts a task, it shows up here.</Hint>
      ) : (
        <ul className="px-1">
          {tasks.slice(0, 8).map((t) => (
            <li key={t.id}>
              <Link
                href={`/tasks/${t.id}`}
                className="block px-2 py-1.5 mx-1 rounded hover:bg-secondary transition-colors"
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xs font-medium truncate flex-1 min-w-0">{t.title}</span>
                  <StatusDot status={t.status} />
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground truncate">
                  {t.assignee_label ?? "(unassigned)"} · {t.status}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusDot({ status }: { status: TaskListItem["status"] }) {
  const cls =
    status === "in_progress"
      ? "bg-status-running"
      : status === "review"
      ? "bg-status-review"
      : status === "blocked"
      ? "bg-status-blocked"
      : status === "done"
      ? "bg-status-done"
      : status === "failed"
      ? "bg-status-failed"
      : "bg-status-pending";
  const animate = status === "in_progress" || status === "review";
  return (
    <span
      className={cn(
        "shrink-0 inline-block h-1.5 w-1.5 rounded-full",
        cls,
        animate && "animate-pulse",
      )}
    />
  );
}

// ── Recent activity ─────────────────────────────────────────────────────

function RecentActivity() {
  const { data, isLoading } = useQuery<ActivityEntry[]>({
    queryKey: queryKeys.activity.feed(),
    queryFn: ({ signal }) => api.activity.list({ limit: 15, signal }),
    enabled: isApiConfigured,
    staleTime: 5_000,
  });

  const entries = data ?? [];

  return (
    <section className="pb-3">
      <SectionHeader icon={Activity} label="Recent activity" count={entries.length || undefined} />
      {isLoading ? (
        <RowSkeleton count={3} />
      ) : entries.length === 0 ? (
        <Hint icon={Activity}>Sessions across your agents will stream here.</Hint>
      ) : (
        <ul className="px-1">
          {entries.map((e) => (
            <li key={e.id}>
              <Link
                href={
                  e.task_id && e.task_short_id
                    ? sessionHref(e.id, e.task_id)
                    : sessionHref(e.id)
                }
                className="block px-2 py-1.5 mx-1 rounded hover:bg-secondary transition-colors"
              >
                <div className="flex items-baseline gap-1.5">
                  <ActivityIcon type={e.type} />
                  <span className="text-xs font-medium truncate flex-1 min-w-0">
                    {e.task_title ?? truncate(e.intent, 60)}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/80 shrink-0">
                    {formatRelativeTime(e.started_at)}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground truncate flex items-center gap-1">
                  <span className="text-foreground/70">{e.agent_label}</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{ACTIVITY_LABEL[e.type] ?? e.type}</span>
                  {e.status === "running" ? (
                    <>
                      <span className="text-muted-foreground/50">·</span>
                      <span className="inline-flex items-center gap-1 text-status-running">
                        <span className="h-1 w-1 rounded-full bg-status-running animate-pulse" />
                        running
                      </span>
                    </>
                  ) : e.status === "failed" ? (
                    <>
                      <span className="text-muted-foreground/50">·</span>
                      <span className="text-status-failed">failed</span>
                    </>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ACTIVITY_LABEL: Partial<Record<SessionType, string>> = {
  chat: "chat",
  task: "task",
  mesh_ask: "asked another agent",
  mesh_negotiate: "negotiating",
  blocker: "reported blocker",
};

function ActivityIcon({ type }: { type: SessionType }) {
  const Icon =
    type === "chat"
      ? MessageCircle
      : type === "task"
      ? Wrench
      : type === "mesh_ask"
      ? Network
      : type === "blocker"
      ? ShieldQuestion
      : Activity;
  return <Icon className="h-3 w-3 shrink-0 text-muted-foreground/80" />;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function RowSkeleton({ count }: { count: number }) {
  return (
    <ul className="px-1 space-y-1">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="px-2 py-1.5 mx-1 rounded">
          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          <div className="mt-1.5 h-2.5 w-1/2 rounded bg-muted/70 animate-pulse" />
        </li>
      ))}
    </ul>
  );
}

function Hint({
  icon: Icon,
  children,
}: {
  icon: typeof Sparkles;
  children: React.ReactNode;
}) {
  return (
    <div className="px-3 pb-2 text-[11px] text-muted-foreground/80 leading-relaxed flex items-start gap-1.5">
      <Icon className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/60" />
      <span>{children}</span>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
