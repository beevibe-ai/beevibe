"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { AlertTriangle, Bot, ExternalLink, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { CoreBlockCard } from "@/components/agents/core-block-card";
import { RecentSessionRow } from "@/components/agents/recent-session-row";
import { EmptyState } from "@/components/empty-state";
import { HierChip } from "@/components/hier-chip";
import { Skeleton } from "@/components/skeleton";
import { isApiConfigured } from "@/lib/api/config";
import { useAgent } from "@/lib/hooks/use-agents";
import { useIsOwner } from "@/lib/hooks/use-me";
import { formatReviewPolicy } from "@/lib/format";
import type { AgentDetail } from "@/lib/api/types";

/**
 * Notion-style peek panel for an agent. Anchored to the right of the
 * canvas it overlays; the canvas stays interactive underneath for
 * comparison-by-click. Keep the layout single-column — the full
 * /agents/:id route exists for the wider deep-dive.
 */
export function AgentDetailPanel({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);

  // Esc closes the panel — same pattern as Notion peek and most
  // dialog/drawer components. Bound at window level so focus inside
  // the panel doesn't have to be on a focusable element.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Click-outside closes. Listener attaches on mount, so the click
  // that *opened* the panel (which fired before the panel rendered)
  // doesn't race-trigger close.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.target instanceof Node && panel.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-label="Agent details"
      data-pan="ignore"
      className="absolute right-0 top-0 bottom-0 w-[520px] max-w-full bg-card border-l border-border shadow-xl flex flex-col"
    >
      <PanelHeader agentId={agentId} onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <PanelBody agentId={agentId} />
      </div>
    </aside>
  );
}

function PanelHeader({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 h-11 border-b border-border/60 shrink-0">
      <Link
        href={`/agents/${agentId}`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ExternalLink className="h-3 w-3" />
        Open full page
      </Link>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close panel"
        title="Close (Esc)"
        className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function PanelBody({ agentId }: { agentId: string }) {
  const { data, isLoading, isError } = useAgent(agentId);

  if (!isApiConfigured) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Bot}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL to load this agent."
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-5 space-y-4">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-4">
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load agent"
          description={`Agent ${agentId} could not be fetched.`}
        />
      </div>
    );
  }

  return <PanelLoaded agent={data} />;
}

function PanelLoaded({ agent }: { agent: AgentDetail }) {
  const isOwner = useIsOwner(agent.owner_id);
  const initial = agent.display_name.charAt(0).toUpperCase();
  const presence = agent.metrics.sessions > 0 ? "idle" : "off";

  return (
    <div className="px-5 py-5">
      <header>
        <div className="flex items-start gap-3">
          <Avatar
            initial={initial}
            kind={agent.hierarchy}
            label={agent.display_name}
            specialization={agent.specialization}
            size={48}
            presence={presence}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-base font-semibold leading-tight truncate">
                {agent.display_name}
              </h2>
              <HierChip hier={agent.hierarchy} />
            </div>
            {agent.specialization ? (
              <p className="text-xs text-muted-foreground line-clamp-3">
                {agent.specialization}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground/60 italic">No tagline yet</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 mt-5 pt-4 border-t border-border/60">
          <PanelMetric label="Sessions" value={agent.metrics.sessions} />
          <PanelMetric label="Facts" value={agent.metrics.facts} />
          <PanelMetric label="Merges" value={agent.metrics.merges} />
          <PanelMetric label="Promoted" value={agent.metrics.promoted} />
        </div>
      </header>

      <Section
        title="Core memory"
        count={agent.core_blocks.length}
        empty="No core blocks."
      >
        {agent.core_blocks.length > 0 ? (
          <div className="space-y-2.5">
            {agent.core_blocks.map((b) => (
              <CoreBlockCard
                key={b.id}
                agentId={agent.id}
                block={b}
                editable={isOwner === true}
              />
            ))}
          </div>
        ) : null}
      </Section>

      <Section
        title="Recent sessions"
        count={agent.recent_sessions.length}
        empty="No recent sessions."
      >
        {agent.recent_sessions.length > 0 ? (
          <ul className="space-y-1.5">
            {agent.recent_sessions.map((s, i) => (
              <RecentSessionRow key={s.short_id ?? i} session={s} variant="compact" />
            ))}
          </ul>
        ) : null}
      </Section>

      {agent.outgoing_mesh_hints.length > 0 ? (
        <Section title="Outgoing mesh" count={agent.outgoing_mesh_hints.length}>
          <ul className="space-y-2">
            {agent.outgoing_mesh_hints.map((hint, i) => (
              <li key={i} className="text-xs">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-foreground/85 truncate">{hint.target}</span>
                  <span className="text-muted-foreground/70 shrink-0">· {hint.age}</span>
                </div>
                <p className="text-muted-foreground line-clamp-2 mt-0.5">{hint.intent}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <footer className="mt-6 pt-4 border-t border-border/60 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
        <PanelFooterField label="ID">
          <ClickToCopyId id={agent.id} />
        </PanelFooterField>
        <PanelFooterField label="Owner">{agent.owner_label ?? "—"}</PanelFooterField>
        <PanelFooterField label="Hierarchy">{agent.hierarchy}</PanelFooterField>
        {agent.runtime ? (
          <PanelFooterField label="Runtime">{agent.runtime}</PanelFooterField>
        ) : null}
        <PanelFooterField label="Review">
          {formatReviewPolicy(agent.review_policy)}
        </PanelFooterField>
      </footer>
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-semibold">
        {title}{" "}
        <span className="text-muted-foreground/70 tabular-nums">{count}</span>
      </h3>
      {count === 0 && empty ? (
        <p className="text-xs text-muted-foreground italic">{empty}</p>
      ) : (
        children
      )}
    </section>
  );
}

function PanelMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-base font-semibold tabular-nums leading-none">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/80">
        {label}
      </div>
    </div>
  );
}

function PanelFooterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wider text-muted-foreground/70 mb-0.5 text-[10px]">
        {label}
      </div>
      <div className="text-foreground/85 truncate">{children}</div>
    </div>
  );
}
