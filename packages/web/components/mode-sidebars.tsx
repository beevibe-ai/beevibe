"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, Inbox, ListChecks, Users } from "lucide-react";
import {
  api,
  type ActivityEntry,
  type Room,
} from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { useAgents } from "@/lib/hooks/use-agents";
import { useTasks } from "@/lib/hooks/use-tasks";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import type { AgentDisplay } from "@/lib/types/agents";
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
        <li key={i} className="px-2 py-2 mx-1 my-0.5 rounded">
          <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
          <div className="mt-1.5 h-2.5 w-full rounded bg-muted/70 animate-pulse" />
        </li>
      ))}
    </ul>
  );
}

function ListEmpty({ icon: Icon, title }: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  return (
    <div className="px-4 py-6 text-center text-xs text-muted-foreground">
      <Icon className="h-5 w-5 mx-auto mb-2 text-muted-foreground/50" />
      <div>{title}</div>
    </div>
  );
}

// ── Home — recent activity ───────────────────────────────────────────

export function HomeSidebar() {
  const { data, isLoading } = useQuery<ActivityEntry[]>({
    queryKey: queryKeys.activity.feed(),
    queryFn: ({ signal }) => api.activity.list({ signal, limit: 15 }),
    enabled: isApiConfigured,
    staleTime: 10_000,
  });

  return (
    <SectionFrame label="Recent activity">
      {isLoading ? (
        <ListSkeleton />
      ) : !data || data.length === 0 ? (
        <ListEmpty icon={Activity} title="Nothing yet — start a conversation or assign a task." />
      ) : (
        <ul>
          {data.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </SectionFrame>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  // Activity entries are session rows. Link to the session detail
  // page when a short_id is available; fall back to the agent
  // otherwise. Title prioritizes the task it ran on, then the intent.
  const title = entry.task_title ?? entry.intent;
  const href = entry.short_id ? `/sessions/${entry.short_id}` : `/agents/${entry.agent_id}`;
  return (
    <li>
      <Link
        href={href}
        className="block px-3 py-1.5 mx-1 my-0.5 rounded hover:bg-secondary/60 transition-colors"
      >
        <div className="flex items-baseline gap-1.5">
          <div className="text-xs text-foreground/85 font-medium truncate flex-1 min-w-0">
            {title}
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
            {entry.duration_label}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
          {entry.agent_label}
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

// ── Agents — flat list with hierarchy badges ─────────────────────────

export function AgentsSidebar({ activeAgentId }: { activeAgentId?: string }) {
  const { data, isLoading } = useAgents();
  const agents = data ?? [];

  return (
    <SectionFrame label="Your team">
      {isLoading ? (
        <ListSkeleton />
      ) : agents.length === 0 ? (
        <ListEmpty icon={Bot} title="No agents yet." />
      ) : (
        <ul>
          {agents.map((agent) => (
            <AgentSidebarRow key={agent.id} agent={agent} active={activeAgentId === agent.id} />
          ))}
        </ul>
      )}
    </SectionFrame>
  );
}

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
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">
        {label}
      </div>
      <div className="flex-1 overflow-y-auto pb-1">{children}</div>
    </div>
  );
}
