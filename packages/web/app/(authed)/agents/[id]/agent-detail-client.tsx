"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AlertTriangle, Bot, Archive } from "lucide-react";
import { useAgent } from "@/lib/hooks/use-agents";
import { useIsOwner, useMe } from "@/lib/hooks/use-me";
import { isApiConfigured } from "@/lib/api/config";
import { formatReviewPolicy } from "@/lib/format";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import { Avatar } from "@/components/avatar";
import { CliMcpInstructions } from "@/components/cli-mcp-instructions";
import { HierChip } from "@/components/hier-chip";
import { CoreBlockCard } from "@/components/agents/core-block-card";
import { RecentSessionRow } from "@/components/agents/recent-session-row";
import { RuntimePicker } from "@/components/agents/pickers/runtime-picker";
import { ModelPicker } from "@/components/agents/pickers/model-picker";
import { ReviewPolicyPicker } from "@/components/agents/pickers/review-policy-picker";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { DetailShell } from "@/components/detail/detail-shell";
import { FooterField } from "@/components/detail/footer-field";
import { Metric } from "@/components/detail/metric";
import { cn } from "@/lib/utils";
import type { AgentDetail } from "@/lib/api/types";

const AgentsBackLink = () => (
  <Link
    href="/agents"
    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
  >
    <ArrowLeft className="h-3 w-3" />
    Agents
  </Link>
);

export function AgentDetailClient({ agentId }: { agentId: string }) {
  const { data, isLoading, isError } = useAgent(agentId);

  if (!isApiConfigured) {
    return (
      <DetailShell nav={<AgentsBackLink />}>
        <EmptyState
          icon={Bot}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load this agent."
        />
      </DetailShell>
    );
  }

  if (isLoading) {
    return (
      <DetailShell nav={<AgentsBackLink />}>
        <Skeleton className="h-14 w-full mb-6" />
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-4">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </DetailShell>
    );
  }

  if (isError || !data) {
    return (
      <DetailShell nav={<AgentsBackLink />}>
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load agent"
          description={`Agent ${agentId} could not be fetched.`}
        />
      </DetailShell>
    );
  }

  return <AgentDetailLoaded agent={data} />;
}

function AgentDetailLoaded({ agent }: { agent: AgentDetail }) {
  const initial = agent.display_name.charAt(0).toUpperCase();
  const presence = agent.metrics.sessions > 0 ? "idle" : "off";
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const archiveMutation = useMutation({
    mutationFn: () => api.agents.archive(agent.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      router.push("/agents");
    },
  });
  const archived = Boolean(agent.archived_at);
  // Cross-user discovery is allowed (GET /agent/:id ungated for mesh
  // visibility), but every mutation route checks owner_id. Hide pickers
  // + archive when the caller doesn't own the agent. Tri-state — `null`
  // while /me loads so the cold-mount render doesn't briefly hide owner
  // controls before resolving.
  const isOwner = useIsOwner(agent.owner_id);
  // The human MCP route keys off the caller's user token and dispatches
  // to whatever `findTopLevelForOwner` returns — i.e. the caller's
  // primary agent. Surfacing "Connect your CLI" anywhere else would be
  // misleading: pointing your CLI at /mcp won't reach that agent.
  const { data: me } = useMe();
  const isPrimaryAgent =
    isOwner === true && me?.primary_agent?.id === agent.id;
  // Aside only renders when it has content. For non-owners with no
  // outgoing mesh, we'd otherwise reserve 1/3 of the grid for an empty
  // column — main expands to full width in that case.
  const showAside = isOwner === true || agent.outgoing_mesh_hints.length > 0;

  return (
    <DetailShell nav={<AgentsBackLink />}>
      <header className="mb-6">
        <div className="flex items-start gap-4">
          <Avatar
            initial={initial}
            kind={agent.hierarchy}
            label={agent.display_name}
            specialization={agent.specialization}
            size={56}
            presence={presence}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-base font-semibold tracking-tight leading-tight">{agent.display_name}</h1>
              <HierChip hier={agent.hierarchy} />
              {archived ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  archived
                </span>
              ) : null}
            </div>
            {agent.specialization ? (
              <p className="text-sm text-muted-foreground">{agent.specialization}</p>
            ) : null}
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {!archived && isOwner === true ? (
              confirming ? (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={archiveMutation.isPending}
                    className="h-8 px-3 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => archiveMutation.mutate()}
                    disabled={archiveMutation.isPending}
                    className="h-8 px-3 rounded text-xs font-medium border border-destructive bg-destructive/10 text-destructive hover:bg-destructive/15 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {archiveMutation.isPending ? "Archiving…" : "Confirm archive"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="h-8 px-3 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer inline-flex items-center gap-1"
                >
                  <Archive className="h-3 w-3" />
                  Archive
                </button>
              )
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-x-8 mt-6 pt-6 border-t border-border">
          <Metric label="Sessions" value={agent.metrics.sessions} />
          <Metric label="Facts learned" value={agent.metrics.facts} />
          <Metric label="Merges" value={agent.metrics.merges} />
          <Metric label="Promoted" value={agent.metrics.promoted} />
        </div>
      </header>

      <div className={cn("grid gap-6", showAside ? "grid-cols-3" : "grid-cols-1")}>
        <div className={cn("space-y-5", showAside ? "col-span-2" : "col-span-1")}>
          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
              Core memory{" "}
              <span className="text-muted-foreground/70 tabular-nums">
                {agent.core_blocks.length}
              </span>
            </h2>
            {agent.core_blocks.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No core blocks.</p>
            ) : (
              <div className="space-y-3">
                {agent.core_blocks.map((b) => (
                  <CoreBlockCard
                    key={b.id}
                    agentId={agent.id}
                    block={b}
                    editable={isOwner === true}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
              Recent sessions{" "}
              <span className="text-muted-foreground/70 tabular-nums">
                {agent.recent_sessions.length}
              </span>
            </h2>
            {agent.recent_sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No recent sessions.</p>
            ) : (
              <ul className="space-y-2">
                {agent.recent_sessions.map((s, i) => (
                  <RecentSessionRow
                    key={s.short_id ?? i}
                    session={s}
                    variant="comfortable"
                  />
                ))}
              </ul>
            )}
          </section>

          {isPrimaryAgent ? (
            <section>
              <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
                Connect your CLI
              </h2>
              <p className="text-xs text-muted-foreground mb-3 max-w-prose">
                Pipe your local CLI through the human MCP endpoint so you can
                drive this team agent from a terminal session.
              </p>
              <CliMcpInstructions />
            </section>
          ) : null}
        </div>

        {showAside ? (
          <aside className="col-span-1 space-y-4">
            {isOwner === true ? (
              <>
                <RuntimePicker agent={agent} />
                <ModelPicker agent={agent} />
                <ReviewPolicyPicker agent={agent} />
              </>
            ) : null}
            {agent.outgoing_mesh_hints.length ? (
              <section className="rounded-lg border border-border bg-card p-4">
                <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
                  Outgoing mesh
                </h3>
                <ul className="space-y-2">
                  {agent.outgoing_mesh_hints.map((hint, i) => (
                    <li key={i} className="text-xs">
                      <span className="text-foreground/85">{hint.target}</span>{" "}
                      <span className="text-muted-foreground/70">· {hint.age}</span>
                      <p className="text-muted-foreground line-clamp-1">{hint.intent}</p>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>

      <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
        <FooterField label="ID">
          <ClickToCopyId id={agent.id} />
        </FooterField>
        <FooterField label="Owner">{agent.owner_label ?? "—"}</FooterField>
        <FooterField label="Hierarchy">{agent.hierarchy}</FooterField>
        {agent.runtime ? <FooterField label="Runtime">{agent.runtime}</FooterField> : null}
        <FooterField label="Model">{agent.model ?? "CLI default"}</FooterField>
        <FooterField label="Review policy">
          {formatReviewPolicy(agent.review_policy)}
        </FooterField>
        {agent.archived_at ? (
          <FooterField label="Archived">
            {new Date(agent.archived_at).toLocaleString()}
          </FooterField>
        ) : null}
      </footer>
    </DetailShell>
  );
}
