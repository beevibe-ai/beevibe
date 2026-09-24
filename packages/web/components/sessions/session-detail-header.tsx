import type { ReactNode } from "react";
import type { HierarchyLevel, SessionStatus } from "@beevibe/core";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { SessionStatusPill } from "@/components/detail/status-pill";

/**
 * The agent identity header shared by the two session detail pages:
 * `/sessions/[sid]` (a chat conversation) and
 * `/tasks/[id]/sessions/[sid]` (one task session).
 *
 * Both render the same entity — an agent's session — and had a byte-identical
 * copy of this block: same wrapper, same four derived `Avatar` props (initial
 * from the label, `presence` keyed off `status === "running"`), same
 * title-plus-pill row, same meta row opening with the label and hier chip.
 * Two pages disagreeing about, say, when the presence pip lights up is the
 * kind of drift a user notices and a test does not.
 *
 * What legitimately differs stays at the call site: `title` carries its own
 * `<h1>` (one page shows a fixed label, the other a truncated free-text
 * intent, and they class it differently), and `children` fills the rest of
 * the meta row after the hier chip.
 */
export function SessionDetailHeader({
  agentLabel,
  agentHierarchy,
  status,
  title,
  children,
}: {
  agentLabel: string;
  agentHierarchy: HierarchyLevel;
  status: SessionStatus;
  title: ReactNode;
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
            {title}
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
