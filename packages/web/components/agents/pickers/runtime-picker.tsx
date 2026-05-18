"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RuntimesListResponse } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/api/types";

type RuntimeOption = {
  id: string;
  cli: string;
  cli_version?: string;
  online: boolean;
  device: string;
};

function flattenRuntimes(data: RuntimesListResponse | undefined): RuntimeOption[] {
  return (
    data?.daemons.flatMap((d) =>
      d.runtimes.map((r) => ({
        id: r.id,
        cli: r.cli,
        cli_version: r.cli_version,
        online: r.online,
        device: d.device_name ?? d.external_id,
      })),
    ) ?? []
  );
}

/**
 * Bare `<select>` for an agent's preferred runtime. Used in table rows
 * where the surrounding chrome supplies its own heading + help text.
 * The card-wrapped form is `RuntimePicker`.
 */
export function RuntimeSelect({
  agent,
  className,
  autoFocus,
}: {
  agent: AgentDisplay;
  className?: string;
  autoFocus?: boolean;
}) {
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

  const runtimes = flattenRuntimes(runtimesQuery.data);
  const value = agent.preferred_runtime_id ?? "";

  if (runtimesQuery.isLoading) {
    return <p className="text-xs text-muted-foreground italic">Loading…</p>;
  }

  if (runtimes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No daemons.{" "}
        <Link href="/runtimes" className="underline hover:text-foreground">
          Set up
        </Link>
      </p>
    );
  }

  return (
    <>
      <select
        value={value}
        autoFocus={autoFocus}
        disabled={mutation.isPending}
        onChange={(e) => {
          const next = e.target.value === "" ? null : e.target.value;
          mutation.mutate(next);
        }}
        className={cn(
          "w-full text-sm rounded border border-border bg-background px-2 py-1.5 cursor-pointer disabled:opacity-50",
          className,
        )}
      >
        <option value="">— unbound —</option>
        {runtimes.map((r) => (
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
    </>
  );
}

/**
 * Card-wrapped runtime picker for the agent detail aside. Composes
 * `RuntimeSelect` with the section heading + help copy users saw in
 * the original sidebar.
 */
export function RuntimePicker({ agent }: { agent: AgentDisplay }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        Runtime
      </h3>
      <RuntimeSelect agent={agent} />
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
    </section>
  );
}
