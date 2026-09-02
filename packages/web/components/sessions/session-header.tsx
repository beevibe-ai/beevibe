import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { SessionStatusPill } from "@/components/detail/status-pill";
import type { SessionDisplay } from "@/lib/types/sessions";

interface Props {
  /** Agent's display name — seeds the avatar initial and the byline. */
  agentLabel: string;
  agentHierarchy: SessionDisplay["agent_hierarchy"];
  /** Drives both the status pill and the avatar's running/idle dot. */
  status: SessionDisplay["status"];
  /** Page title: the session's intent, or "Conversation" / "One turn". */
  title: string;
  /**
   * Trailing byline items, rendered after the hierarchy chip. Genuinely
   * per-page — the task view shows a duration, the chat view a turn count
   * and the session type — so each supplies its own separators.
   */
  meta?: ReactNode;
}

/**
 * The identity header both session detail pages open with: who ran it, what
 * it was, and whether it's still going.
 *
 * `/tasks/[id]/sessions/[sid]` and `/sessions/[sid]` had written out the
 * same twenty lines — the same avatar wiring (initial from the label,
 * `presence` keyed off `status === "running"`), the same nested flex
 * scaffold, the same `agent_label` + `<HierChip>` byline. Only the title
 * and the trailing byline items differed, and those are the two props.
 *
 * The two copies had already drifted on the `<h1>`: one carried
 * `tracking-tight`, the other `truncate`. This keeps both — `truncate` is
 * inert on the short literal titles the chat view passes, and needs the
 * `min-w-0` that the wrapper below already sets.
 */
export function SessionHeader({
  agentLabel,
  agentHierarchy,
  status,
  title,
  meta,
}: Props) {
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
