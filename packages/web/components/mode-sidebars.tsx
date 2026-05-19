"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Cpu,
  GaugeCircle,
  Inbox,
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
import { useInbox } from "@/lib/hooks/use-inbox";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InboxItem, InboxItemKind } from "@/lib/types/inbox";

/**
 * Per-mode sidebar lists. Each mode in the icon strip shows its own
 * relevant drilldown below the strip — no empty rails.
 *
 * - Agents → links to the canvas + sibling observability surfaces
 *   (Metrics / Memory / Mesh / Promotions). The canvas IS the page;
 *   the rail just gives quick navigation between sibling views.
 * - Rooms → rooms list
 * - Tasks → "Needs you" inbox: tasks waiting on the human (review,
 *   blocked, escalations) with inline quick actions.
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
  { href: "/runtimes", label: "Runtimes", icon: Cpu },
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
                  "flex items-center gap-2 h-7 px-2 mx-1 my-0.5 rounded text-xs",
                  active
                    ? "glassy-chip font-semibold"
                    : "text-muted-foreground/85 hover:text-foreground hover:bg-secondary/60 transition-colors",
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

// ── Tasks: "Needs you" attention inbox ───────────────────────────────

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

/**
 * Extract the entity id from an InboxItem id of shape `<kind>:<id>`.
 * Returns null when the kind isn't task-shaped (so we never try to
 * peek-open a non-task surface like an escalation).
 */
function inboxTaskId(item: InboxItem): string | null {
  if (item.kind !== "task_review" && item.kind !== "task_blocked") return null;
  const sep = item.id.indexOf(":");
  return sep > 0 ? item.id.slice(sep + 1) : null;
}

function inboxRowHref(item: InboxItem): string {
  // Tasks open inline as the right peek panel; escalations still
  // navigate to whatever surface the backend pointed at.
  const taskId = inboxTaskId(item);
  if (taskId) return `/tasks?p=${encodeURIComponent(taskId)}`;
  return item.href;
}

export function TasksAttentionSidebar({
  activeTaskId,
}: {
  activeTaskId?: string;
}) {
  const inbox = useInbox();
  const items = inbox.data ?? [];
  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="px-3 pt-3 pb-1 flex items-baseline gap-1.5">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">
          Needs you
        </span>
        {items.length > 0 ? (
          <span className="text-[10px] text-muted-foreground/50 tabular-nums">
            {items.length}
          </span>
        ) : null}
      </div>
      {inbox.isLoading ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <ListEmpty icon={Inbox} title="Inbox zero." />
      ) : (
        <ul>
          {items.map((item) => {
            const taskId = inboxTaskId(item);
            return (
              <AttentionRow
                key={item.id}
                item={item}
                active={taskId !== null && taskId === activeTaskId}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AttentionRow({ item, active }: { item: InboxItem; active: boolean }) {
  const meta = INBOX_KIND_META[item.kind];
  const Icon = meta.icon;
  return (
    <li
      className={cn(
        "mx-1 my-0.5 rounded transition-colors",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <Link href={inboxRowHref(item)} className="block px-3 py-1.5">
        <div className="flex items-baseline gap-1.5">
          <Icon
            className={cn("h-3 w-3 shrink-0 self-center", meta.iconClass)}
            aria-label={meta.label}
          />
          <div
            className={cn(
              "text-xs truncate flex-1 min-w-0",
              active ? "text-foreground font-semibold" : "text-foreground/85 font-medium",
            )}
          >
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
