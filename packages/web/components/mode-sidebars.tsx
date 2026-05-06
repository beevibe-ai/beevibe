"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Inbox,
  ListChecks,
  MessageSquare,
  Network,
  ShieldAlert,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import {
  api,
  type Room,
} from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { useAgents } from "@/lib/hooks/use-agents";
import { useInbox } from "@/lib/hooks/use-inbox";
import { useTasks } from "@/lib/hooks/use-tasks";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import type { AgentDisplay } from "@/lib/types/agents";
import type { InboxItem, InboxItemKind } from "@/lib/types/inbox";
import type { TaskListItem } from "@/lib/types/tasks";
import type { TaskStatus } from "@beevibe/core";
import { cn } from "@/lib/utils";

/**
 * Per-mode sidebar lists. Each mode in the icon strip shows its own
 * relevant drilldown below the strip — no empty rails. Same role
 * Notion's "Past week" / "Private" lists serve under the active mode.
 *
 * - Home → recent activity feed (last 10)
 * - Rooms → rooms list
 * - Tasks → grouped by status with counts
 * - Agents → flat list with hierarchy badges (replaces the old AgentList)
 */

// ── Empty/loading states (shared) ────────────────────────────────────

function ListSkeleton() {
  return (
    <ul className="px-1 py-0.5 space-y-1">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="px-2 py-2 mx-1 my-0.5 space-y-1.5">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-full" />
        </li>
      ))}
    </ul>
  );
}

function ListEmpty({ icon, title }: { icon: LucideIcon; title: string }) {
  return <EmptyState icon={icon} title={title} className="py-6 px-4 text-xs" />;
}

// ── Home — inbox + team + observability + new-chat CTA ──────────────

const HOME_SUBNAV = [
  { href: "/memory", label: "Memory", icon: Sparkles },
  { href: "/mesh", label: "Mesh", icon: Network },
  { href: "/promotions", label: "Promotions", icon: TrendingUp },
] as const;

const INBOX_KIND_META: Record<
  InboxItemKind,
  { icon: LucideIcon; label: string; iconClass: string }
> = {
  task_review: {
    icon: CheckCircle2,
    label: "Awaiting your review",
    iconClass: "text-status-review",
  },
  task_blocked: {
    icon: AlertCircle,
    label: "Blocked",
    iconClass: "text-status-blocked",
  },
  escalation_pending: {
    icon: ShieldAlert,
    label: "Escalated",
    iconClass: "text-status-failed",
  },
};

export function HomeSidebar({
  pathname,
  activeAgentId,
  onNewChat,
}: {
  pathname: string;
  activeAgentId?: string;
  onNewChat: () => void;
}) {
  const inbox = useInbox();
  const agents = useAgents();

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto">
        <SectionLabel>Inbox</SectionLabel>
        {inbox.isLoading ? (
          <ListSkeleton />
        ) : !inbox.data || inbox.data.length === 0 ? (
          <ListEmpty icon={Inbox} title="Inbox zero." />
        ) : (
          <ul>
            {inbox.data.map((item) => (
              <InboxRow key={item.id} item={item} />
            ))}
          </ul>
        )}

        <SectionLabel>Your team</SectionLabel>
        {agents.isLoading ? (
          <ListSkeleton />
        ) : !agents.data || agents.data.length === 0 ? (
          <ListEmpty icon={Bot} title="No agents yet." />
        ) : (
          <ul>
            {agents.data.map((agent) => (
              <AgentSidebarRow
                key={agent.id}
                agent={agent}
                active={activeAgentId === agent.id}
              />
            ))}
          </ul>
        )}

        <SectionLabel>Observability</SectionLabel>
        <ul className="px-1 pb-2">
          {HOME_SUBNAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 h-7 px-2 mx-1 my-0.5 rounded text-xs transition-colors",
                    active
                      ? "bg-secondary text-foreground font-semibold"
                      : "text-muted-foreground/85 hover:text-foreground hover:bg-secondary/60",
                  )}
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <NewChatCTA onClick={onNewChat} />
    </div>
  );
}

function NewChatCTA({ onClick }: { onClick: () => void }) {
  // Pinned-bottom primary action — same role as Notion's "+ New chat".
  // Always one click away regardless of which mode the user is on.
  return (
    <div className="px-2 py-2 border-t border-border/60">
      <button
        type="button"
        onClick={onClick}
        className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-full bg-secondary text-foreground hover:bg-secondary/80 text-xs font-medium transition-colors cursor-pointer"
      >
        <MessageSquare className="h-3.5 w-3.5" />
        <span>New chat</span>
      </button>
    </div>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const meta = INBOX_KIND_META[item.kind];
  const Icon = meta.icon;
  return (
    <li>
      <Link
        href={item.href}
        className="block px-3 py-1.5 mx-1 my-0.5 rounded hover:bg-secondary/60 transition-colors"
      >
        <div className="flex items-baseline gap-1.5">
          <Icon
            className={cn("h-3 w-3 shrink-0 self-center", meta.iconClass)}
            aria-label={meta.label}
          />
          <div className="text-xs text-foreground/85 font-medium truncate flex-1 min-w-0">
            {item.title}
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
            {formatRelativeTime(item.age_at)}
          </span>
        </div>
        <div className="mt-0.5 ml-[18px] text-[11px] text-muted-foreground line-clamp-1">
          {item.detail}
        </div>
      </Link>
    </li>
  );
}

// ── Rooms list ───────────────────────────────────────────────────────

export function RoomsSidebar({ activeRoomId }: { activeRoomId?: string }) {
  const { data, isLoading } = useQuery<{ ok: true; rooms: Room[] }>({
    queryKey: queryKeys.rooms.list(),
    queryFn: ({ signal }) => api.rooms.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });

  const rooms = data?.rooms ?? [];

  return (
    <SectionFrame label="Your rooms">
      {isLoading ? (
        <ListSkeleton />
      ) : rooms.length === 0 ? (
        <ListEmpty icon={Inbox} title="No rooms yet." />
      ) : (
        <ul>
          {rooms.map((room) => {
            const active = activeRoomId === room.id;
            return (
              <li key={room.id}>
                <Link
                  href={`/rooms/${room.id}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block px-3 py-1.5 mx-1 my-0.5 rounded transition-colors",
                    active ? "bg-secondary" : "hover:bg-secondary/60",
                  )}
                >
                  <div className="flex items-baseline gap-1.5">
                    <div
                      className={cn(
                        "text-xs truncate flex-1 min-w-0",
                        active
                          ? "text-foreground font-semibold"
                          : "text-foreground/85 font-medium",
                      )}
                    >
                      {room.name}
                    </div>
                    <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
                      {formatRelativeTime(room.updated_at)}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionFrame>
  );
}

// ── Tasks grouped by status ──────────────────────────────────────────

const TASK_STATUS_ORDER: TaskStatus[] = [
  "blocked",
  "review",
  "in_progress",
  "pending",
  "assigned",
  "done",
];

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  assigned: "Assigned",
  in_progress: "In progress",
  review: "In review",
  revision: "Needs revision",
  needs_revision: "Needs revision",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function TasksSidebar({ activeTaskId }: { activeTaskId?: string }) {
  const { data, isLoading } = useTasks({});
  const tasks = data ?? [];

  const grouped = TASK_STATUS_ORDER.map((status) => ({
    status,
    items: tasks.filter((t) => t.status === status),
  })).filter((g) => g.items.length > 0);

  return (
    <SectionFrame label="Tasks">
      {isLoading ? (
        <ListSkeleton />
      ) : tasks.length === 0 ? (
        <ListEmpty icon={ListChecks} title="No tasks yet." />
      ) : (
        <div>
          {grouped.map(({ status, items }) => (
            <div key={status} className="mb-1.5 last:mb-0">
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60 flex items-baseline gap-1.5">
                <span>{TASK_STATUS_LABELS[status]}</span>
                <span className="text-muted-foreground/50 tabular-nums">{items.length}</span>
              </div>
              <ul>
                {items.slice(0, 8).map((t) => (
                  <TaskRow key={t.id} task={t} active={activeTaskId === t.id} />
                ))}
                {items.length > 8 ? (
                  <li className="px-3 py-1 text-[10px] text-muted-foreground/60">
                    +{items.length - 8} more
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionFrame>
  );
}

function TaskRow({ task, active }: { task: TaskListItem; active: boolean }) {
  return (
    <li>
      <Link
        href={`/tasks/${task.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "block px-3 py-1.5 mx-1 my-0.5 rounded transition-colors",
          active ? "bg-secondary" : "hover:bg-secondary/60",
        )}
      >
        <div
          className={cn(
            "text-xs truncate",
            active ? "text-foreground font-semibold" : "text-foreground/85",
          )}
        >
          {task.title}
        </div>
        {task.assignee_label ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
            {task.assignee_label}
          </div>
        ) : null}
      </Link>
    </li>
  );
}

// ── Agent row (used by Home sidebar) ─────────────────────────────────

function AgentSidebarRow({ agent, active }: { agent: AgentDisplay; active: boolean }) {
  // ICs indent under their team — same visual ladder as Notion's
  // nested page tree. No drag-to-reorder; the hierarchy comes from
  // parent_agent_id on the server.
  const indent = agent.hierarchy === "ic" ? "pl-6" : "pl-3";
  return (
    <li>
      <Link
        href={`/agents/${agent.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2 h-7 pr-2 mx-1 my-0.5 rounded transition-colors",
          indent,
          active ? "bg-secondary" : "hover:bg-secondary/60",
        )}
      >
        <Bot
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "flex-1 truncate text-xs",
            active ? "text-foreground font-semibold" : "text-foreground/85",
          )}
        >
          {agent.display_name}
        </span>
        <span
          className={cn(
            "shrink-0 px-1 py-px rounded text-[9px] font-mono uppercase tracking-wide",
            agent.hierarchy === "team" && "bg-hier-team/15 text-hier-team",
            agent.hierarchy === "org" && "bg-hier-org/15 text-hier-org",
            agent.hierarchy === "ic" && "bg-muted text-muted-foreground",
          )}
        >
          {agent.hierarchy}
        </span>
      </Link>
    </li>
  );
}

// ── Section frame (shared) ───────────────────────────────────────────

function SectionFrame({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <SectionLabel>{label}</SectionLabel>
      <div className="flex-1 overflow-y-auto pb-1">{children}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">
      {children}
    </div>
  );
}
