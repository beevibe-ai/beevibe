"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { type LucideIcon, AlertTriangle, ListChecks } from "lucide-react";
import { ViewTabs } from "@/components/tasks/view-tabs";
import { BoardColumn } from "@/components/tasks/board-column";
import { EmptyState } from "@/components/empty-state";
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";
import { useTasks } from "@/lib/hooks/use-tasks";
import { isApiConfigured } from "@/lib/api/config";
import { countArchivedTasks, groupTasks } from "@/lib/tasks-grouping";

interface EmptyMessage {
  icon: LucideIcon;
  title: string;
  description: string;
  cta?: { href: string; label: string };
}

export function TasksClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTaskId = searchParams?.get("p") ?? undefined;

  const [query, setQuery] = useState("");
  // Cancelled + failed are noise on the default board — agents fail
  // more than humans intend, and a "Cancelled" column always-visible
  // would dominate the board. Default closed; surface count + toggle
  // in the header so the morgue stays accessible without dominating.
  const [showArchived, setShowArchived] = useState(false);

  const openTask = useCallback(
    (taskId: string) => {
      // Replace, not push — opening the panel shouldn't make the back
      // button bounce through every task the user clicked. Closing
      // (cleared param) DOES push so back restores the panel.
      router.replace(`/tasks?p=${encodeURIComponent(taskId)}`, { scroll: false });
    },
    [router],
  );
  const closeTask = useCallback(() => {
    router.push("/tasks", { scroll: false });
  }, [router]);

  const { data, isLoading, isFetching, isError } = useTasks({});

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((t) => t.title.toLowerCase().includes(q));
  }, [data, query]);

  const archivedCount = useMemo(() => countArchivedTasks(filtered), [filtered]);
  const lanes = useMemo(
    () => groupTasks(filtered, { showArchived }),
    [filtered, showArchived],
  );
  const emptyMessage = pickEmptyMessage({
    isApiConfigured,
    isError,
    isLoading,
    isFetching,
    hasResults: filtered.length > 0,
    hasQuery: query.length > 0,
  });
  // When there's no data at all (no tasks period), replace the board entirely
  // with the empty state — otherwise the 5 empty `min-h-full` lanes push the
  // hint off-screen. With a query that just doesn't match, keep the board so
  // the user still sees the lanes are there + a "no matches" inline hint.
  const fullScreenEmpty = emptyMessage && !query;

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden">
      <ViewTabs
        onSearch={() => {}}
        query={query}
        onQueryChange={setQuery}
        archivedCount={archivedCount}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
      />

      {fullScreenEmpty ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="max-w-md w-full">
            <EmptyState {...emptyMessage} />
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-auto">
          {/* w-full forces the flex row to fill the scroll container so
              flex-1 children share the available width; overflow-x-auto
              kicks in only when all lanes hit their min-width. */}
          <div className="group/board flex gap-4 px-6 py-5 min-h-full w-full">
            {lanes.map((lane) => (
              <BoardColumn
                key={lane.key}
                lane={lane}
                onSelectTask={openTask}
                activeTaskId={selectedTaskId}
              />
            ))}
          </div>
          {emptyMessage ? (
            <div className="px-6 pb-8 max-w-md mx-auto">
              <EmptyState {...emptyMessage} />
            </div>
          ) : null}
        </div>
      )}

      {selectedTaskId ? (
        <TaskDetailPanel taskId={selectedTaskId} onClose={closeTask} />
      ) : null}
    </div>
  );
}

function pickEmptyMessage(state: {
  isApiConfigured: boolean;
  isError: boolean;
  isLoading: boolean;
  isFetching: boolean;
  hasResults: boolean;
  hasQuery: boolean;
}): EmptyMessage | null {
  if (state.isError) {
    return {
      icon: AlertTriangle,
      title: "Couldn't load tasks",
      description:
        "The API is configured but unreachable. Check that the MCP server is running.",
    };
  }
  if (!state.isApiConfigured) {
    return {
      icon: ListChecks,
      title: "No tasks yet",
      description: "Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load tasks.",
    };
  }
  // Suppress the empty state while ANY fetch is in flight — including a
  // background refetch where `data === []` is cached. Without this guard,
  // navigating /chat → /tasks after an SSE-triggered cache invalidation
  // briefly shows "No tasks yet" until the refetch settles, even though
  // the api is about to return the new task. `isLoading` only catches
  // the initial-fetch case (no data yet); `isFetching` covers refetches.
  if (state.isLoading || state.isFetching || state.hasResults) return null;
  if (state.hasQuery) {
    return {
      icon: ListChecks,
      title: "No matching tasks",
      description: "Try a different search.",
    };
  }
  return {
    icon: ListChecks,
    title: "No tasks yet",
    description: "Tasks are minted by talking to your team agent. Ask it what's worth doing.",
    cta: { href: "/", label: "Open chat" },
  };
}
