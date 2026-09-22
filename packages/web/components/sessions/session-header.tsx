import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { SessionStatusPill } from "@/components/detail/status-pill";
import type { SessionDisplay } from "@/lib/types/sessions";

/**
 * Header for the two session detail pages — `/sessions/[sid]` (a chat
 * conversation) and `/tasks/[id]/sessions/[sid]` (a task's session).
 *
 * Both opened with the same block: agent avatar with live presence, title
 * plus status pill, then a meta line of agent label, hierarchy chip and
 * page-specific facts. Written out twice, the two had already drifted —
 * one heading carried `tracking-tight`, the other `truncate`. This applies
 * both, so the two pages' headings render alike.
 *
 * Everything below the hierarchy chip is the `meta` slot, which is where
 * the pages genuinely differ (turn count + type vs. elapsed duration).
 */
export function SessionDetailHeader({
  agentLabel,
  agentHierarchy,
  status,
  title,
  meta,
}: {
  agentLabel: string;
  agentHierarchy: SessionDisplay["agent_hierarchy"];
  status: SessionDisplay["status"];
  title: string;
  meta?: ReactNode;
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
            <h1 className="text-base font-semibold tracking-tight leading-tight truncate">
              {title}
            </h1>
            <SessionStatusPill status={status} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-foreground/85">{agentLabel}</span>
            <HierChip hier={agentHierarchy} />
            {meta}
          </div>
        </div>
      </div>
    </header>
  );
}

/** The `·` separator the meta line uses between facts. */
export function MetaDot() {
  return <span className="text-muted-foreground/50">·</span>;
}
