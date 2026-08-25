import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { cn } from "@/lib/utils";
import type { SessionDisplay } from "@/lib/types/sessions";

/**
 * The identity block at the top of a session detail page: the agent's
 * avatar (its presence dot driven by the session status), the page title
 * with its status pill, and a meta row naming the agent and its tier.
 *
 * Both session pages — the task-scoped one and the chat-conversation one —
 * rendered this identically; only the title and the trailing meta items
 * differ, so those are the props. `children` lands after the `HierChip`,
 * where each page adds its own facts (turn count and type for a
 * conversation, elapsed duration for a task session).
 */
export function SessionHeader({
  agentLabel,
  agentHierarchy,
  status,
  title,
  truncateTitle,
  children,
}: {
  agentLabel: string;
  agentHierarchy: SessionDisplay["agent_hierarchy"];
  status: SessionDisplay["status"];
  title: string;
  /** Titles derived from a free-text intent need clamping; fixed ones don't. */
  truncateTitle?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <div className="flex items-start gap-3">
        <Avatar
          initial={agentLabel.charAt(0).toUpperCase()}
          kind={agentHierarchy}
          label={agentLabel}
          size={40}
          presence={status === "running" ? "running" : "idle"}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1
              className={cn(
                "text-base font-semibold tracking-tight leading-tight",
                truncateTitle && "truncate",
              )}
            >
              {title}
            </h1>
            <SessionStatusPill status={status} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-foreground/85">{agentLabel}</span>
            <HierChip hier={agentHierarchy} />
            {children}
          </div>
        </div>
      </div>
    </header>
  );
}

/** Separator between meta items in a {@link SessionHeader}'s meta row. */
export function SessionHeaderDot() {
  return <span className="text-muted-foreground/50">·</span>;
}
