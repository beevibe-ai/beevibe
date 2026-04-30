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

interface StatusConfig {
  icon: LucideIcon;
  iconColor: string;
  label: string;
  textColor: string;
  spin?: boolean;
}

const STATUS_CONFIG: Record<TaskStatus, StatusConfig> = {
  pending:        { icon: Circle,        iconColor: "text-status-pending",  label: "pending",        textColor: "" },
  assigned:       { icon: CircleDashed,  iconColor: "text-status-pending",  label: "assigned",       textColor: "" },
  in_progress:    { icon: Loader2,       iconColor: "text-status-running",  label: "in progress",    textColor: "text-status-running", spin: true },
  needs_revision: { icon: Loader2,       iconColor: "text-status-running",  label: "needs revision", textColor: "text-status-running", spin: true },
  revision:       { icon: Loader2,       iconColor: "text-status-running",  label: "revision",       textColor: "text-status-running", spin: true },
  review:         { icon: AlertCircle,   iconColor: "text-status-review",   label: "review",         textColor: "text-status-review" },
  blocked:        { icon: Ban,           iconColor: "text-status-blocked",  label: "blocked",        textColor: "text-status-blocked" },
  done:           { icon: CheckCircle2,  iconColor: "text-status-done",     label: "done",           textColor: "text-status-done" },
  failed:         { icon: XCircle,       iconColor: "text-status-failed",   label: "failed",         textColor: "text-status-failed" },
  cancelled:      { icon: XCircle,       iconColor: "text-status-cancelled", label: "cancelled",     textColor: "" },
};

export function TaskStatusIcon({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <Icon
      className={cn(
        "h-4 w-4 mt-0.5 shrink-0",
        config.iconColor,
        config.spin && "animate-spin-slow",
        className,
      )}
    />
  );
}

export function statusLabel(status: TaskStatus): string {
  return STATUS_CONFIG[status].label;
}

export function statusTextColor(status: TaskStatus): string {
  return STATUS_CONFIG[status].textColor;
}
