import type {
  TaskStatus,
  SessionStatus,
  EscalationStatus,
  NegotiationStatus,
} from "@beevibe/core";
import { cn } from "@/lib/utils";

interface DotPillConfig {
  dot: string;
  bg: string;
  text: string;
  label: string;
}

const TASK_PILL: Record<TaskStatus, DotPillConfig> = {
  review: { dot: "bg-status-review", bg: "bg-status-review/10", text: "text-status-review", label: "review" },
  blocked: { dot: "bg-status-blocked", bg: "bg-status-blocked/10", text: "text-status-blocked", label: "blocked" },
  in_progress: { dot: "bg-status-running animate-pulse-breathe", bg: "bg-status-running/10", text: "text-status-running", label: "in progress" },
  revision: { dot: "bg-status-running animate-pulse-breathe", bg: "bg-status-running/10", text: "text-status-running", label: "revision" },
  needs_revision: { dot: "bg-status-running animate-pulse-breathe", bg: "bg-status-running/10", text: "text-status-running", label: "needs revision" },
  done: { dot: "bg-status-done", bg: "bg-status-done/10", text: "text-status-done", label: "done" },
  failed: { dot: "bg-status-failed", bg: "bg-status-failed/10", text: "text-status-failed", label: "failed" },
  pending: { dot: "bg-status-pending", bg: "bg-secondary", text: "text-muted-foreground", label: "pending" },
  assigned: { dot: "bg-status-pending", bg: "bg-secondary", text: "text-muted-foreground", label: "assigned" },
  cancelled: { dot: "bg-status-cancelled", bg: "bg-secondary", text: "text-muted-foreground", label: "cancelled" },
};

const SESSION_PILL: Record<SessionStatus, { bg: string; text: string; label: string; pulse?: boolean }> = {
  pending: { bg: "bg-secondary", text: "text-muted-foreground", label: "pending" },
  running: { bg: "bg-status-running/10", text: "text-status-running", label: "running", pulse: true },
  succeeded: { bg: "bg-status-done/10", text: "text-status-done", label: "succeeded" },
  failed: { bg: "bg-status-failed/10", text: "text-status-failed", label: "failed" },
  cancelled: { bg: "bg-secondary", text: "text-muted-foreground", label: "cancelled" },
};

const ESCALATION_PILL: Record<EscalationStatus, DotPillConfig> = {
  pending: { dot: "bg-status-review", bg: "bg-status-review/10", text: "text-status-review", label: "pending" },
  resolved: { dot: "bg-status-done", bg: "bg-status-done/10", text: "text-status-done", label: "resolved" },
  cancelled: { dot: "bg-status-cancelled", bg: "bg-secondary", text: "text-muted-foreground", label: "cancelled" },
};

const NEGOTIATION_PILL: Record<NegotiationStatus, DotPillConfig> = {
  active: { dot: "bg-status-running", bg: "bg-status-running/10", text: "text-status-running", label: "active" },
  accepted: { dot: "bg-status-done", bg: "bg-status-done/10", text: "text-status-done", label: "accepted" },
  rejected: { dot: "bg-status-failed", bg: "bg-status-failed/10", text: "text-status-failed", label: "rejected" },
  escalated: { dot: "bg-status-review", bg: "bg-status-review/10", text: "text-status-review", label: "escalated" },
  cancelled: { dot: "bg-status-cancelled", bg: "bg-secondary", text: "text-muted-foreground", label: "cancelled" },
};

function DotPill({ config, className }: { config: DotPillConfig; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 h-6 px-2 rounded text-xs font-medium",
        config.bg,
        config.text,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", config.dot)} />
      {config.label}
    </span>
  );
}

export function TaskStatusPill({ status, className }: { status: TaskStatus; className?: string }) {
  return <DotPill config={TASK_PILL[status]} className={className} />;
}

export function SessionStatusPill({ status, className }: { status: SessionStatus; className?: string }) {
  const config = SESSION_PILL[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 h-5 px-1.5 rounded text-[10px] font-medium",
        config.bg,
        config.text,
        className,
      )}
    >
      {config.pulse ? <span className="animate-pulse-breathe h-1.5 w-1.5 rounded-full bg-status-running" /> : null}
      {config.label}
    </span>
  );
}

export function EscalationStatusPill({ status, className }: { status: EscalationStatus; className?: string }) {
  return <DotPill config={ESCALATION_PILL[status]} className={className} />;
}

export function NegotiationStatusPill({ status, className }: { status: NegotiationStatus; className?: string }) {
  return <DotPill config={NEGOTIATION_PILL[status]} className={className} />;
}

export function PriorityPill({ priority }: { priority: string }) {
  return (
    <span className="inline-flex items-center h-6 px-2 rounded text-xs font-medium bg-secondary text-secondary-foreground">
      {priority}
    </span>
  );
}
