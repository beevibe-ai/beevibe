import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  Loader2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { TaskStatus } from "@beevibe/core";
import { cn } from "@/lib/utils";

interface StatusVisual {
  icon: LucideIcon;
  color: string;
  spin?: boolean;
}

const STATUS_VISUAL: Record<TaskStatus, StatusVisual> = {
  pending: { icon: Circle, color: "text-status-pending" },
  assigned: { icon: CircleDashed, color: "text-status-pending" },
  in_progress: { icon: Loader2, color: "text-status-running", spin: true },
  needs_revision: { icon: Loader2, color: "text-status-running", spin: true },
  revision: { icon: Loader2, color: "text-status-running", spin: true },
  review: { icon: AlertCircle, color: "text-status-review" },
  blocked: { icon: Ban, color: "text-status-blocked" },
  done: { icon: CheckCircle2, color: "text-status-done" },
  failed: { icon: XCircle, color: "text-status-failed" },
  cancelled: { icon: XCircle, color: "text-status-cancelled" },
};

export function TaskStatusIcon({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  const visual = STATUS_VISUAL[status];
  const Icon = visual.icon;
  return (
    <Icon
      className={cn(
        "h-4 w-4 mt-0.5 shrink-0",
        visual.color,
        visual.spin && "animate-spin-slow",
        className,
      )}
    />
  );
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "pending",
  assigned: "assigned",
  in_progress: "in progress",
  needs_revision: "needs revision",
  revision: "revision",
  review: "review",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const STATUS_TEXT_COLOR: Record<TaskStatus, string> = {
  pending: "",
  assigned: "",
  in_progress: "text-status-running",
  needs_revision: "text-status-running",
  revision: "text-status-running",
  review: "text-status-review",
  blocked: "text-status-blocked",
  done: "text-status-done",
  failed: "text-status-failed",
  cancelled: "",
};

export function statusLabel(status: TaskStatus): string {
  return STATUS_LABEL[status];
}

export function statusTextColor(status: TaskStatus): string {
  return STATUS_TEXT_COLOR[status];
}
