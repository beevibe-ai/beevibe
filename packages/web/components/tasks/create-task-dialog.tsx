"use client";

import { useState } from "react";
import { Dialog } from "@/components/dialog";
import { useAgents } from "@/lib/hooks/use-agents";
import { useCreateTask } from "@/lib/hooks/use-task-mutations";
import type { TaskPriority } from "@beevibe/core";

const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "critical"];

export function CreateTaskDialog({
  open,
  onClose,
  defaultParentTaskId,
}: {
  open: boolean;
  onClose: () => void;
  /** Pre-fill parent_task_id (e.g., when "+ New" is clicked from a parent task page). */
  defaultParentTaskId?: string;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [assigneeId, setAssigneeId] = useState<string>("");

  const { data: agents } = useAgents();
  const createTask = useCreateTask();

  const reset = () => {
    setTitle("");
    setDescription("");
    setPriority("medium");
    setAssigneeId("");
    createTask.reset();
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    createTask.mutate(
      {
        title: trimmed,
        description: description.trim() || undefined,
        priority,
        assignee_id: assigneeId || undefined,
        parent_task_id: defaultParentTaskId,
      },
      { onSuccess: close },
    );
  };

  const submitDisabled = createTask.isPending || title.trim().length === 0;

  return (
    <Dialog open={open} onClose={close} title="New task">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Title" htmlFor="task-title">
          <input
            id="task-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Wire up the dashboard"
            autoFocus
            required
            className="w-full h-9 rounded border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </Field>

        <Field label="Description" htmlFor="task-description">
          <textarea
            id="task-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does done look like?"
            rows={3}
            className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority" htmlFor="task-priority">
            <select
              id="task-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="w-full h-9 rounded border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Assignee" htmlFor="task-assignee">
            <select
              id="task-assignee"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className="w-full h-9 rounded border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Unassigned</option>
              {agents?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name} · {a.hierarchy}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {createTask.isError ? (
          <div className="text-xs text-status-failed">
            Couldn&apos;t create: {createTask.error.message}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={close}
            className="h-9 px-3 rounded text-sm font-medium border border-border hover:bg-secondary transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitDisabled}
            className="h-9 px-3 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createTask.isPending ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={htmlFor}
        className="block text-[11px] uppercase tracking-wider text-muted-foreground font-medium"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
