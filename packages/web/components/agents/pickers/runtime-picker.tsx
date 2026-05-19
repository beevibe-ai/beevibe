"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RuntimesListResponse } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import { cn } from "@/lib/utils";
import {
  ChipCaret,
  ChipMenuItem,
  ChipPopover,
  StatusDot,
} from "@/components/agents/pickers/chip-popover";
import type { AgentDisplay } from "@/lib/api/types";

type RuntimeOption = {
  id: string;
  cli: string;
  cli_version?: string;
  online: boolean;
  device: string;
};

type DaemonGroup = {
  device: string;
  runtimes: RuntimeOption[];
};

function groupRuntimesByDaemon(
  data: RuntimesListResponse | undefined,
): DaemonGroup[] {
  if (!data) return [];
  return data.daemons.map((d) => ({
    device: d.device_name ?? d.external_id,
    runtimes: d.runtimes.map((r) => ({
      id: r.id,
      cli: r.cli,
      cli_version: r.cli_version,
      online: r.online,
      device: d.device_name ?? d.external_id,
    })),
  }));
}

function flattenRuntimes(groups: DaemonGroup[]): RuntimeOption[] {
  return groups.flatMap((g) => g.runtimes);
}

function shortRuntimeLabel(r: RuntimeOption): string {
  return r.cli_version ? `${r.cli} ${r.cli_version}` : r.cli;
}

function useRuntimesQuery() {
  return useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    staleTime: 30_000,
  });
}

function useRuntimeMutation(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runtimeId: string | null) =>
      api.agents.setRuntime(agentId, runtimeId),
    onSuccess: () => {
      // The list view consumes data via useAgentNetwork() — that's
      // a separate cache slot (["agent-network", ...]) from the
      // per-agent detail (["agents", ...]). Invalidating only one
      // leaves the other stale, so a mutation appears to silently
      // do nothing in whichever view didn't get its key bumped.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentNetwork.all });
    },
  });
}

/**
 * Chip-style runtime picker for the agent list view. Green dot when
 * bound to an online runtime, amber-outlined "Set runtime" CTA when
 * unbound so the call-to-action is impossible to miss. Click opens a
 * popover with runtimes grouped by daemon.
 */
export function RuntimeChip({ agent }: { agent: AgentDisplay }) {
  const runtimesQuery = useRuntimesQuery();
  const mutation = useRuntimeMutation(agent.id);

  const groups = groupRuntimesByDaemon(runtimesQuery.data);
  const all = flattenRuntimes(groups);
  const current = all.find((r) => r.id === agent.preferred_runtime_id);
  const isUnbound = !current;
  const isOnline = current?.online ?? false;

  // No daemons registered: render a static muted chip linking to /runtimes
  // so the empty-state still tells users where to go.
  if (!runtimesQuery.isLoading && all.length === 0) {
    return (
      <Link
        href="/runtimes"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs leading-none border border-amber-500/30 bg-amber-500/5 text-amber-300 hover:bg-amber-500/10 transition-colors"
      >
        <StatusDot tone="amber" />
        <span>Set up a daemon</span>
      </Link>
    );
  }

  const chipClass = isUnbound
    ? "border border-amber-500/35 bg-amber-500/[0.06] text-amber-300 hover:bg-amber-500/[0.10]"
    : isOnline
      ? "border border-border bg-secondary/40 text-foreground hover:bg-secondary"
      : "border border-border bg-secondary/40 text-muted-foreground hover:bg-secondary";

  return (
    <ChipPopover
      ariaLabel={`Runtime: ${current ? shortRuntimeLabel(current) : "unbound"}. Click to change.`}
      chipClassName={chipClass}
      disabled={mutation.isPending}
      chip={
        <>
          <StatusDot
            tone={isUnbound ? "amber" : isOnline ? "green" : "gray"}
            glow={!isUnbound && isOnline}
          />
          <span className="font-mono tabular-nums">
            {current ? shortRuntimeLabel(current) : "Set runtime"}
          </span>
          <ChipCaret />
        </>
      }
    >
      {(close) => (
        <>
          {groups.map((g, gi) => (
            <div key={gi}>
              <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                {g.device}
              </div>
              {g.runtimes.map((r) => (
                <ChipMenuItem
                  key={r.id}
                  selected={r.id === agent.preferred_runtime_id}
                  leading={<StatusDot tone={r.online ? "green" : "gray"} glow={false} />}
                  label={
                    <span className="font-mono tabular-nums text-[13px]">
                      {shortRuntimeLabel(r)}
                    </span>
                  }
                  sublabel={r.online ? undefined : "offline"}
                  onClick={() => {
                    mutation.mutate(r.id);
                    close();
                  }}
                />
              ))}
            </div>
          ))}
          <div className="my-1 border-t border-border" />
          <ChipMenuItem
            selected={isUnbound}
            leading={<StatusDot tone="amber" glow={false} />}
            label={<span className="text-[13px]">Unbind</span>}
            sublabel="sessions pause"
            onClick={() => {
              mutation.mutate(null);
              close();
            }}
          />
        </>
      )}
    </ChipPopover>
  );
}

/**
 * Card-wrapped runtime picker for the agent detail aside. Keeps the
 * full-width native `<select>` because the side-panel context wants
 * substantial chrome + help copy, not a chip. Reuses the same mutation
 * hook so behavior stays in sync with the chip variant.
 */
export function RuntimePicker({ agent }: { agent: AgentDisplay }) {
  const runtimesQuery = useRuntimesQuery();
  const mutation = useRuntimeMutation(agent.id);
  const all = flattenRuntimes(groupRuntimesByDaemon(runtimesQuery.data));
  const value = agent.preferred_runtime_id ?? "";

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        Runtime
      </h3>
      {runtimesQuery.isLoading ? (
        <p className="text-xs text-muted-foreground italic">Loading runtimes…</p>
      ) : all.length === 0 ? (
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
            className={cn(
              "w-full text-sm rounded border border-border bg-background px-2 py-1.5",
              "cursor-pointer disabled:opacity-50",
            )}
          >
            <option value="">— unbound —</option>
            {all.map((r) => (
              <option key={r.id} value={r.id}>
                {r.device} · {shortRuntimeLabel(r)}
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
          <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
            Don&apos;t see a CLI you just installed?{" "}
            <Link href="/runtimes" className="underline hover:text-foreground">
              Sync your daemon
            </Link>
            .
          </p>
        </>
      )}
    </section>
  );
}
