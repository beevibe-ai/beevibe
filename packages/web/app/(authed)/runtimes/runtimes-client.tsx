"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Cpu,
  HardDrive,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  type DaemonPanelEntry,
  type RuntimePanelEntry,
  type RuntimesListResponse,
} from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { describeError } from "@/lib/api/http";
import { queryKeys } from "@/lib/hooks/keys";
import { formatRelativeTime } from "@/lib/format";
import { CommandBlock } from "@/components/command-block";
import { DaemonInstallInstructions } from "@/components/daemon-install";
import { EmptyPanel } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { cn } from "@/lib/utils";

export function RuntimesClient() {
  const query = useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    enabled: isApiConfigured,
    // SSE invalidates this key on `runtime.updated`; keep cache otherwise
    // long so per-render polling doesn't fight the live updates.
    staleTime: 30_000,
  });

  return (
    <div className="flex-1 overflow-auto">
      <div className="pt-8 pb-12 px-6">
        <div className="max-w-3xl mx-auto mb-8 space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Runtimes</h1>
          <p className="text-sm text-muted-foreground max-w-prose">
            beevibe-daemon runs on your machine and is what spawns your
            agents&apos; CLI subprocesses. Each daemon registers one runtime
            per detected CLI ({" "}
            <span className="font-mono text-foreground/80">claude</span>,{" "}
            <span className="font-mono text-foreground/80">codex</span>,{" "}
            <span className="font-mono text-foreground/80">opencode</span>).
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Body
            data={query.data}
            isLoading={query.isLoading}
            isError={query.isError}
            error={query.error}
          />
        </div>
      </div>
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
  error,
}: {
  data: RuntimesListResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}) {
  if (!isApiConfigured) {
    return (
      <EmptyPanel
        icon={Terminal}
        title="API not configured"
        description="Set NEXT_PUBLIC_BV_API_URL and run the API server to load this page."
      />
    );
  }
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }
  if (isError) {
    return (
      <EmptyPanel
        icon={AlertTriangle}
        title="Couldn't load runtimes"
        description={describeError(error)}
      />
    );
  }
  const daemons = data?.daemons ?? [];
  if (daemons.length === 0) {
    return <NoDaemonsState />;
  }
  return (
    <div className="space-y-3">
      {daemons.map((d) => (
        <DaemonCard key={d.id} daemon={d} />
      ))}
      <SyncNewCli />
      <AddAnotherMachine />
    </div>
  );
}

function DaemonCard({ daemon }: { daemon: DaemonPanelEntry }) {
  const anyOnline = daemon.runtimes.some((r) => r.online);
  return (
    <article className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="px-4 py-3 border-b border-border/60 flex items-start gap-3">
        <div
          className={cn(
            "h-9 w-9 rounded-md flex items-center justify-center shrink-0",
            anyOnline
              ? "bg-status-running/15 text-status-running"
              : "bg-muted text-muted-foreground",
          )}
        >
          <HardDrive className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h2 className="font-medium text-sm truncate">{daemon.device_name}</h2>
            <StatusBadge online={anyOnline} />
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            <span className="font-mono">{daemon.external_id}</span>
            {daemon.last_seen_at ? (
              <>
                {" · last seen "}
                {formatRelativeTime(daemon.last_seen_at)}
              </>
            ) : (
              " · never seen"
            )}
          </div>
        </div>
        <RevokeButton daemonId={daemon.id} deviceName={daemon.device_name ?? "this daemon"} />
      </header>
      <ul className="divide-y divide-border/50">
        {daemon.runtimes.length === 0 ? (
          <li className="px-4 py-3 text-xs text-muted-foreground">
            No runtimes registered for this daemon yet.
          </li>
        ) : (
          daemon.runtimes.map((r) => <RuntimeRow key={r.id} runtime={r} />)
        )}
      </ul>
    </article>
  );
}

function RuntimeRow({ runtime }: { runtime: RuntimePanelEntry }) {
  return (
    <li className="px-4 py-2.5 flex items-center gap-3">
      <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-mono text-foreground">{runtime.cli}</span>
          {runtime.cli_version ? (
            <span className="text-[11px] text-muted-foreground/70">
              {runtime.cli_version}
            </span>
          ) : null}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {runtime.last_heartbeat
            ? `heartbeat ${formatRelativeTime(runtime.last_heartbeat)}`
            : "no heartbeat yet"}
        </div>
      </div>
      <StatusDot online={runtime.online} />
    </li>
  );
}

function StatusBadge({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium",
        online
          ? "bg-status-running/15 text-status-running"
          : "bg-muted text-muted-foreground",
      )}
    >
      <StatusDot online={online} />
      {online ? "online" : "offline"}
    </span>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        online ? "bg-status-running animate-pulse-breathe" : "bg-muted-foreground/40",
      )}
    />
  );
}

function RevokeButton({
  daemonId,
  deviceName,
}: {
  daemonId: string;
  deviceName: string;
}) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: () => api.runtimes.revoke(daemonId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.runtimes.all });
      setConfirming(false);
    },
  });

  if (mutation.isPending) {
    return (
      <span className="text-[11px] text-muted-foreground italic shrink-0">
        revoking…
      </span>
    );
  }
  if (confirming) {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          className="text-[11px] font-medium text-status-failed hover:underline cursor-pointer"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
        >
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      title={`Forget ${deviceName} (revoke daemon credentials)`}
      className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] text-muted-foreground hover:text-status-failed hover:bg-status-failed/10 cursor-pointer transition-colors"
    >
      <Trash2 className="h-3 w-3" />
      Forget
    </button>
  );
}

function NoDaemonsState() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/40 p-8">
      <div className="flex flex-col items-center text-center gap-3">
        <div className="h-12 w-12 rounded-md bg-muted flex items-center justify-center">
          <HardDrive className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-sm">No daemons registered yet</p>
          <p className="text-xs text-muted-foreground max-w-prose">
            Install beevibe-daemon on your machine to spawn agents. Once it
            registers, it&apos;ll show up here.
          </p>
        </div>
        <InstallSnippet />
      </div>
    </div>
  );
}

function AddAnotherMachine() {
  return (
    <ExpandableHint icon={Plus} label="Set up another machine">
      <InstallSnippet />
    </ExpandableHint>
  );
}

function SyncNewCli() {
  return (
    <ExpandableHint
      icon={RefreshCw}
      label="Installed a new CLI on a machine that's already registered?"
      bodyClassName="space-y-2.5 text-xs text-muted-foreground"
    >
      <p>
        Run this on the machine where the daemon is set up. It re-detects
        every supported CLI on <span className="font-mono">PATH</span> and
        registers any new ones here — no reinstall, no token rotation.
      </p>
      <CommandBlock label="On the daemon machine" command="beevibe-daemon sync" />
      <p>
        Restart <span className="font-mono">beevibe-daemon start</span>{" "}
        afterwards so the active poll loop picks up the new runtime.
      </p>
    </ExpandableHint>
  );
}

/**
 * Dashed-border `<details>` block for opt-in setup affordances at the
 * bottom of the runtimes panel. Used by both "Set up another machine"
 * and "Installed a new CLI…" — same visual treatment, different bodies.
 */
function ExpandableHint({
  icon: Icon,
  label,
  bodyClassName,
  children,
}: {
  icon: LucideIcon;
  label: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-dashed border-border bg-card/40">
      <summary className="cursor-pointer px-4 py-3 list-none flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </summary>
      <div className={cn("border-t border-border/60 px-4 py-3", bodyClassName)}>
        {children}
      </div>
    </details>
  );
}

function InstallSnippet() {
  return <DaemonInstallInstructions className="w-full max-w-xl" />;
}
