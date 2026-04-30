import { findSessionById } from "@/lib/fixtures/sessions";

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.floor(diffMonth / 12)}y ago`;
}

export function shortId(id: string): string {
  const trimmed = id.replace(/^[a-z]+_/, "");
  return `#${trimmed.slice(0, 6)}`;
}

export function sessionHref(sid: string, taskId?: string): string {
  if (taskId) return `/tasks/${taskId}/sessions/${sid}`;
  const session = findSessionById(sid);
  const parentTask = session?.task_id ?? "tsk_8a3f1c00000000000000000000";
  return `/tasks/${parentTask}/sessions/${sid}`;
}
