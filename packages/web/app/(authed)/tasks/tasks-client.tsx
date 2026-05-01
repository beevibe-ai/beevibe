"use client";

import { useMemo, useState } from "react";
import { type LucideIcon, AlertTriangle, ListChecks } from "lucide-react";
import { ViewTabs, type TaskView } from "@/components/tasks/view-tabs";
import { BoardColumn } from "@/components/tasks/board-column";
import { CreateTaskDialog } from "@/components/tasks/create-task-dialog";
import { EmptyState } from "@/components/empty-state";
import { useTasks } from "@/lib/hooks/use-tasks";
import { isApiConfigured } from "@/lib/api/config";
import { groupTasks } from "@/lib/tasks-grouping";
import type { TaskListFilter } from "@/lib/api/client";

const VIEW_TO_FILTER: Record<TaskView, TaskListFilter> = {
  all: {},
  mine: { view: "mine" },
  sprint: { view: "sprint" },
  timeline: { view: "timeline" },
};

interface EmptyMessage {
  icon: LucideIcon;
  title: string;
  description: string;
}

export function TasksClient() {
  const [view, setView] = useState<TaskView>("all");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, isError } = useTasks(VIEW_TO_FILTER[view]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((t) => t.title.toLowerCase().includes(q));
  }, [data, query]);

  const lanes = useMemo(() => groupTasks(filtered), [filtered]);
  const emptyMessage = pickEmptyMessage({
    isApiConfigured,
    isError,
    isLoading,
    hasResults: filtered.length > 0,
    hasQuery: query.length > 0,
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <ViewTabs
        current={view}
        onChange={setView}
        onNewTask={() => setCreateOpen(true)}
        onSearch={() => {}}
        query={query}
        onQueryChange={setQuery}
      />

      <div className="flex-1 overflow-x-auto overflow-y-auto">
        <div className="group/board flex gap-4 px-6 py-5 min-h-full">
          {lanes.map((lane) => (
            <BoardColumn key={lane.key} lane={lane} onNewTask={() => setCreateOpen(true)} />
          ))}
          <div className="shrink-0 w-2" aria-hidden />
        </div>

        {emptyMessage ? (
          <div className="px-6 pb-8 max-w-md mx-auto">
            <EmptyState {...emptyMessage} />
          </div>
        ) : null}
      </div>

      <CreateTaskDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function pickEmptyMessage(state: {
  isApiConfigured: boolean;
  isError: boolean;
  isLoading: boolean;
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
  if (state.isLoading || state.hasResults) return null;
  return {
    icon: ListChecks,
    title: state.hasQuery ? "No matching tasks" : "No tasks yet",
    description: state.hasQuery
      ? "Try a different search."
      : "Create a task to assign work to an agent.",
  };
}
