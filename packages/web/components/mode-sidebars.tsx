"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  GaugeCircle,
  Inbox,
  ListChecks,
  Network,
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
import { useTasks } from "@/lib/hooks/use-tasks";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import type { TaskListItem } from "@/lib/types/tasks";
import type { TaskStatus } from "@beevibe/core";
import { cn } from "@/lib/utils";

/**
 * Per-mode sidebar lists. Each mode in the icon strip shows its own
 * relevant drilldown below the strip — no empty rails.
 *
 * - Agents → links to the canvas + sibling observability surfaces
 *   (Metrics / Memory / Mesh / Promotions). The canvas IS the page;
 *   the rail just gives quick navigation between sibling views.
 * - Rooms → rooms list
 * - Tasks → grouped by status with counts
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

// Sibling observability surfaces that share the Agents tab. /agents
// is the canvas itself; the rest are deeper drill-downs (metrics,
// memory facts, mesh activity, promotion events).
const AGENTS_SUBNAV = [
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/dashboard", label: "Metrics", icon: GaugeCircle },
  { href: "/memory", label: "Memory", icon: Sparkles },
  { href: "/mesh", label: "Mesh", icon: Network },
  { href: "/promotions", label: "Promotions", icon: TrendingUp },
] as const;

export function AgentsSidebar({ pathname }: { pathname: string }) {
  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <ul className="px-1 pt-2 pb-2">
        {AGENTS_SUBNAV.map((item) => {
          // /agents matches exactly so it stays highlighted only on
          // the canvas itself, not on any deeper /agents/:id route.
          const active =
            item.href === "/agents"
              ? pathname === "/agents"
              : pathname.startsWith(item.href);
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
