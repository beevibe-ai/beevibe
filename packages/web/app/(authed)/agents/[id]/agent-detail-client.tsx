"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AlertTriangle, Bot, Archive } from "lucide-react";
import { useAgent } from "@/lib/hooks/use-agents";
import { isApiConfigured } from "@/lib/api/config";
import { api, type RuntimesListResponse } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { CoreBlockCard } from "@/components/agents/core-block-card";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { DetailShell } from "@/components/detail/detail-shell";
import { FooterField } from "@/components/detail/footer-field";
import { Metric } from "@/components/detail/metric";
import { cn } from "@/lib/utils";
import type { AgentDetail } from "@/lib/api/types";
import type { RecentSession } from "@/lib/types/agents";
import type { ReviewPolicy } from "@beevibe/core";

const RECENT_SESSION_DOT: Record<RecentSession["status"], string> = {
  running: "bg-status-running animate-pulse-breathe",
  review: "bg-status-review",
  succeeded: "bg-status-done",
};

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

  return (
    <DetailShell nav={<AgentsBackLink />}>
      <header className="mb-6">
        <div className="flex items-start gap-4">
          <Avatar initial={initial} kind={agent.hierarchy} size={56} presence={presence} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl font-semibold leading-tight">{agent.display_name}</h1>
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
            {!archived ? (
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

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-5">
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
                  <CoreBlockCard key={b.id} block={b} />
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
                  <RecentSessionRow key={s.short_id ?? i} session={s} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="col-span-1 space-y-4">
          <RuntimePicker agent={agent} />
          <ModelPicker agent={agent} />
          <ReviewPolicyPicker agent={agent} />
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
      </div>

      <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
        <FooterField label="ID">
          <ClickToCopyId id={agent.id} />
        </FooterField>
        <FooterField label="Hierarchy">{agent.hierarchy}</FooterField>
        {agent.runtime ? <FooterField label="Runtime">{agent.runtime}</FooterField> : null}
        <FooterField label="Model">{agent.model ?? "CLI default"}</FooterField>
        {agent.archived_at ? (
          <FooterField label="Archived">
            {new Date(agent.archived_at).toLocaleString()}
          </FooterField>
        ) : null}
      </footer>
    </DetailShell>
  );
}

function RecentSessionRow({ session }: { session: RecentSession }) {
  const rowInner = (
    <>
      <span
        className={cn("h-1.5 w-1.5 rounded-full", RECENT_SESSION_DOT[session.status])}
        aria-hidden
      />
      <span className="flex-1 min-w-0 truncate">{session.title}</span>
      {session.short_id ? (
        <span className="font-mono text-xs text-muted-foreground">{session.short_id}</span>
      ) : null}
      <span className="text-xs text-muted-foreground tabular-nums shrink-0">{session.age}</span>
    </>
  );

  // Without a short_id we can't route anywhere — render unlinked so we
  // don't ship a dead <Link>. RecentSession.short_id is currently always
  // populated in practice; this is defensive against future shapes.
  if (!session.short_id) {
    return (
      <li className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        {rowInner}
      </li>
    );
  }

  return (
    <li>
      <Link
        href={`/sessions/${session.short_id}`}
        className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-secondary/50 hover:border-border/80 transition-colors cursor-pointer"
      >
        {rowInner}
      </Link>
    </li>
  );
}

// Common Claude model aliases the CLI accepts. Users can also pick "Other"
// to type a pinned model ID (e.g. claude-opus-4-7). The empty-string sentinel
// represents "CLI default" — clears `runtime_config.model` server-side.
const MODEL_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "CLI default (recommended)" },
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
  { value: "haiku", label: "haiku" },
];

function ModelPicker({ agent }: { agent: AgentDetail }) {
  const queryClient = useQueryClient();
  const current = agent.model ?? "";
  const isPreset = MODEL_PRESETS.some((p) => p.value === current);
  // Lazy initializers so we don't recompute MODEL_PRESETS.some on every
  // render — useState only consumes the seed on mount.
  const [customMode, setCustomMode] = useState(() => !isPreset && current !== "");
  const [customValue, setCustomValue] = useState(() => (isPreset ? "" : current));

  // Resync local state when agent.model changes underneath us (SSE refresh,
  // user navigates to a different agent without unmounting, etc.). Without
  // this, the custom-input field would show stale text after an external
  // update.
  useEffect(() => {
    const nextIsPreset = MODEL_PRESETS.some((p) => p.value === current);
    setCustomMode(!nextIsPreset && current !== "");
    setCustomValue(nextIsPreset ? "" : current);
  }, [current]);

  const mutation = useMutation({
    mutationFn: (model: string | null) => api.agents.setModel(agent.id, model),
    onSuccess: () => {
      // Targeted invalidation — only this agent's detail. Was previously
      // queryKeys.agents.all which refetches every agent list across the
      // app, which is unnecessary for a per-agent model change.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent.id),
      });
    },
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        Model
      </h3>
      <select
        value={customMode ? "__custom" : current}
        disabled={mutation.isPending}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__custom") {
            setCustomMode(true);
            return;
          }
          setCustomMode(false);
          // "" means CLI default → null clears the field server-side.
          mutation.mutate(v === "" ? null : v);
        }}
        className="w-full text-sm rounded border border-border bg-background px-2 py-1.5 cursor-pointer disabled:opacity-50"
      >
        {MODEL_PRESETS.map((p) => (
          <option key={p.value || "__default"} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value="__custom">Other (pinned model ID)…</option>
      </select>
      {customMode ? (
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const v = customValue.trim();
            if (v) mutation.mutate(v);
          }}
        >
          <input
            type="text"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            placeholder="e.g. claude-opus-4-7"
            className="flex-1 text-sm rounded border border-border bg-background px-2 py-1.5"
          />
          <button
            type="submit"
            disabled={mutation.isPending || !customValue.trim()}
            className="h-7 px-3 rounded text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
          >
            Set
          </button>
        </form>
      ) : null}
      {mutation.isError ? (
        <p className="text-xs text-destructive mt-1.5">
          Couldn&apos;t update model.
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground mt-2 leading-snug">
        Model alias passed to the CLI via <span className="font-mono">--model</span>.
        Leave on &quot;CLI default&quot; to inherit whatever you&apos;ve
        configured in <span className="font-mono">~/.claude</span>.
      </p>
    </section>
  );
}

function ReviewPolicyPicker({ agent }: { agent: AgentDetail }) {
  const queryClient = useQueryClient();
  // Legacy agents (provisioned before this column had a default) carry
  // review_policy=null; behaviorally that's identical to 'auto_done' in
  // TaskService, so render it that way too.
  const current: ReviewPolicy =
    agent.review_policy === "require_human" ? "require_human" : "auto_done";
  const mutation = useMutation({
    mutationFn: (policy: ReviewPolicy) => api.agents.setReviewPolicy(agent.id, policy),
    // Invalidate all agent queries: the list view's AgentDisplay also
    // carries review_policy, so a single agent's flip can affect
    // /agents cards + the peek panel, not just this detail page.
    // Mirrors RuntimePicker's invalidation scope.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    },
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        Review policy
      </h3>
      <select
        value={current}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.value as ReviewPolicy)}
        className="w-full text-sm rounded border border-border bg-background px-2 py-1.5 cursor-pointer disabled:opacity-50"
      >
        <option value="auto_done">Auto-done (default)</option>
        <option value="require_human">Require human review</option>
      </select>
      {mutation.isError ? (
        <p className="text-xs text-destructive mt-1.5">
          Couldn&apos;t update review policy.
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground mt-2 leading-snug">
        When the agent declares a task <span className="font-mono">done</span>,
        auto-done closes it. Require-human routes it through{" "}
        <span className="font-mono">review</span> so you sign off first.
      </p>
    </section>
  );
}

function RuntimePicker({ agent }: { agent: AgentDetail }) {
  const queryClient = useQueryClient();
  const runtimesQuery = useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (runtimeId: string | null) => api.agents.setRuntime(agent.id, runtimeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    },
  });

  const allRuntimes =
    runtimesQuery.data?.daemons.flatMap((d) =>
      d.runtimes.map((r) => ({
        id: r.id,
        cli: r.cli,
        cli_version: r.cli_version,
        online: r.online,
        device: d.device_name ?? d.external_id,
      })),
    ) ?? [];

  const value = agent.preferred_runtime_id ?? "";

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        Runtime
      </h3>
      {runtimesQuery.isLoading ? (
        <p className="text-xs text-muted-foreground italic">Loading runtimes…</p>
      ) : allRuntimes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No daemons registered yet.{" "}
          <Link href="/runtimes" className="underline hover:text-foreground">
            Set up a daemon
          </Link>
          .
        </p>
      ) : (
        <>
          <select
            value={value}
            disabled={mutation.isPending}
            onChange={(e) => {
              const next = e.target.value === "" ? null : e.target.value;
              mutation.mutate(next);
            }}
            className="w-full text-sm rounded border border-border bg-background px-2 py-1.5 cursor-pointer disabled:opacity-50"
          >
            <option value="">— unbound —</option>
            {allRuntimes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.device} · {r.cli}
                {r.cli_version ? ` ${r.cli_version}` : ""}
                {r.online ? " (online)" : " (offline)"}
              </option>
            ))}
          </select>
          {mutation.isError ? (
            <p className="text-xs text-destructive mt-1.5">
              Couldn&apos;t update runtime.
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground mt-2 leading-snug">
            The agent runs on this daemon&apos;s CLI. Unbinding makes task / chat
            sessions sit pending until rebound; mesh asks fall back to the
            server.
          </p>
        </>
      )}
    </section>
  );
}
