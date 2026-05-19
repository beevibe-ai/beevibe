"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Cpu,
  Loader2,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { api, type RuntimesListResponse } from "@/lib/api/client";
import { DaemonInstallInstructions } from "@/components/daemon-install";
import { queryKeys } from "@/lib/hooks/keys";
import { useMe } from "@/lib/hooks/use-me";
import { cn } from "@/lib/utils";

type Step = "intro" | "install" | "pick" | "ready";
const STEPS: Step[] = ["intro", "install", "pick", "ready"];

export function WelcomeClient() {
  const router = useRouter();
  const { data: me, isLoading } = useMe();
  const [step, setStep] = useState<Step>("intro");
  const [boundRuntimeId, setBoundRuntimeId] = useState<string | null>(null);

  // Already onboarded — drop straight into chat. /me is the source of
  // truth so a stale tab can't accidentally re-show the wizard.
  useEffect(() => {
    if (me && !me.needs_onboarding) {
      router.replace("/");
    }
  }, [me, router]);

  if (!isApiConfigured) {
    return <NotConfigured />;
  }

  if (isLoading || (me && !me.needs_onboarding)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border/60 px-6 py-3">
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Beevibe"
            className="h-6 w-6 rounded-md object-cover object-center"
          />
          <span className="text-sm font-semibold tracking-tight">Beevibe</span>
          <Stepper current={step} className="ml-auto" />
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div
          key={step}
          className="max-w-2xl w-full motion-safe:animate-[wizard-step_180ms_ease-out_both]"
        >
          {step === "intro" ? <IntroStep onNext={() => setStep("install")} /> : null}
          {step === "install" ? (
            <InstallStep onDaemonReady={() => setStep("pick")} />
          ) : null}
          {step === "pick" ? (
            <PickRuntimeStep
              teamAgentId={me?.primary_agent?.id}
              onPicked={(runtimeId) => {
                setBoundRuntimeId(runtimeId);
                setStep("ready");
              }}
            />
          ) : null}
          {step === "ready" ? (
            <ReadyStep
              boundRuntimeId={boundRuntimeId}
              onContinue={() => router.replace("/?from=welcome")}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function Stepper({ current, className }: { current: Step; className?: string }) {
  const idx = STEPS.indexOf(current);
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground",
        className,
      )}
    >
      {STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-1.5">
          <span
            className={cn(
              "h-2 w-2 rounded-full transition-colors",
              i <= idx ? "bg-primary" : "bg-muted-foreground/50",
            )}
          />
          {i < STEPS.length - 1 ? (
            <span
              className={cn(
                "h-0.5 w-5 rounded-full transition-colors",
                i < idx ? "bg-primary" : "bg-muted-foreground/40",
              )}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ── Step 1: intro ──────────────────────────────────────────────────────

function IntroStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-8">
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to beevibe.</h1>
        <p className="text-base text-muted-foreground max-w-prose mx-auto leading-relaxed">
          Your AI agents run on <span className="text-foreground font-medium">your machine</span>{" "}
          via a small daemon — the api just dispatches work to it. Two short
          steps and you&apos;re chatting with your team agent.
        </p>
      </div>

      <ol className="rounded-lg border border-border/60 bg-card p-5 space-y-3 text-sm">
        <li className="flex items-start gap-3">
          <span className="mt-0.5 h-5 w-5 rounded-full bg-secondary text-foreground text-[11px] font-semibold flex items-center justify-center shrink-0">
            1
          </span>
          <span>
            Install the <span className="font-mono">beevibe-daemon</span> on this
            machine. One command — we&apos;ll wait for it to come online.
          </span>
        </li>
        <li className="flex items-start gap-3">
          <span className="mt-0.5 h-5 w-5 rounded-full bg-secondary text-foreground text-[11px] font-semibold flex items-center justify-center shrink-0">
            2
          </span>
          <span>
            Pick which CLI runtime your team agent should use (just{" "}
            <span className="font-mono">claude</span> for most folks).
          </span>
        </li>
      </ol>

      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer text-sm font-medium"
        >
          Set up my daemon
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ── Step 2: install daemon — show command, poll until it appears ──────

function InstallStep({ onDaemonReady }: { onDaemonReady: () => void }) {
  // Poll /runtimes every 3s until at least one daemon shows up.
  const query = useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
  });
  const daemonCount = query.data?.daemons.length ?? 0;
  const hasDaemon = daemonCount > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold">Install the daemon</h2>
        <p className="text-sm text-muted-foreground max-w-prose mx-auto">
          The daemon spawns your agents&apos; CLI subprocesses on your machine.
          Pick the install path that fits your setup:
        </p>
      </div>

      <DaemonInstallInstructions className="max-w-xl mx-auto" />

      <div
        className={cn(
          "max-w-xl mx-auto rounded-lg border p-4 transition-colors",
          hasDaemon
            ? "border-status-done/40 bg-status-done/5"
            : "border-border bg-card",
        )}
      >
        {hasDaemon ? (
          <div className="flex items-center gap-2 text-sm">
            <Check className="h-4 w-4 text-status-done shrink-0" />
            <span className="text-foreground font-medium">
              {daemonCount === 1 ? "1 daemon" : `${daemonCount} daemons`} online.
            </span>
            <button
              type="button"
              onClick={onDaemonReady}
              className="ml-auto inline-flex items-center gap-1 h-7 px-3 rounded text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer"
            >
              Continue
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>Waiting for your daemon to register…</span>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground text-center max-w-md mx-auto leading-relaxed">
        Need <span className="font-mono">claude</span>? Install Claude Code first
        (<span className="font-mono">npm i -g @anthropic/claude-code</span>) and
        run <span className="font-mono">claude login</span>.
      </p>
    </div>
  );
}

// ── Step 3: pick which runtime to bind to the team agent ──────────────

function PickRuntimeStep({
  teamAgentId,
  onPicked,
}: {
  teamAgentId: string | undefined;
  onPicked: (runtimeId: string) => void;
}) {
  const queryClient = useQueryClient();
  // Same refetch cadence as InstallStep — both use the shared
  // queryKeys.runtimes.list() key so React Query dedupes the in-flight
  // request, but mismatched intervals would still cause refetch thrash
  // on step transition.
  const query = useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    refetchInterval: 3_000,
  });

  const allRuntimes = useMemo(
    () =>
      (query.data?.daemons ?? []).flatMap((d) =>
        d.runtimes.map((r) => ({
          id: r.id,
          cli: r.cli,
          cli_version: r.cli_version,
          online: r.online,
          device: d.device_name ?? d.external_id,
        })),
      ),
    [query.data],
  );

  const [selected, setSelected] = useState<string | null>(null);
  // Auto-select the first online runtime to make the happy path one-click.
  useEffect(() => {
    if (selected) return;
    const firstOnline = allRuntimes.find((r) => r.online);
    if (firstOnline) setSelected(firstOnline.id);
  }, [allRuntimes, selected]);

  const mutation = useMutation({
    mutationFn: (runtimeId: string) => {
      if (!teamAgentId) throw new Error("no team agent");
      return api.agents.setRuntime(teamAgentId, runtimeId);
    },
    onSuccess: (_data, runtimeId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      onPicked(runtimeId);
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold">Pick a runtime</h2>
        <p className="text-sm text-muted-foreground max-w-prose mx-auto">
          Bind your team agent to a CLI on one of your daemons. You can change
          this later from the agent&apos;s detail page.
        </p>
      </div>

      <div className="max-w-xl mx-auto space-y-2">
        {allRuntimes.length === 0 ? (
          <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            Looking for runtimes…
          </div>
        ) : (
          allRuntimes.map((r) => (
            <RuntimeCard
              key={r.id}
              runtime={r}
              selected={selected === r.id}
              onSelect={() => setSelected(r.id)}
            />
          ))
        )}
      </div>

      {mutation.isError ? (
        <div className="max-w-xl mx-auto rounded-md border border-status-failed/40 bg-status-failed/5 p-3 text-xs text-status-failed flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>Couldn&apos;t bind that runtime. Try another?</span>
        </div>
      ) : null}

      <div className="flex items-center justify-center">
        <button
          type="button"
          disabled={!selected || mutation.isPending || !teamAgentId}
          onClick={() => selected && mutation.mutate(selected)}
          className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-sm font-medium"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Binding…
            </>
          ) : (
            <>
              Use this runtime
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function RuntimeCard({
  runtime,
  selected,
  onSelect,
}: {
  runtime: {
    id: string;
    cli: string;
    cli_version?: string;
    online: boolean;
    device: string;
  };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-3 rounded-md border p-3 text-left transition-colors cursor-pointer",
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:bg-secondary/40",
      )}
    >
      <Cpu className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-medium text-foreground">{runtime.device}</span>
          <span className="text-xs text-muted-foreground/70 font-mono">
            · {runtime.cli}
            {runtime.cli_version ? ` ${runtime.cli_version}` : ""}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {runtime.online ? "online" : "offline (waiting for heartbeat)"}
        </div>
      </div>
      <span
        className={cn(
          "h-2 w-2 rounded-full shrink-0",
          runtime.online
            ? "bg-status-running animate-pulse-breathe"
            : "bg-muted-foreground/40",
        )}
      />
      {selected ? <Check className="h-4 w-4 text-primary shrink-0" /> : null}
    </button>
  );
}

// ── Step 4: ready ─────────────────────────────────────────────────────

function ReadyStep({
  boundRuntimeId,
  onContinue,
}: {
  boundRuntimeId: string | null;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-6 text-center">
      <div className="space-y-3">
        <div className="mx-auto h-12 w-12 rounded-full bg-status-done/15 border border-status-done/40 flex items-center justify-center">
          <Sparkles className="h-5 w-5 text-status-done" />
        </div>
        <h2 className="text-xl font-semibold">You&apos;re set.</h2>
        <p className="text-sm text-muted-foreground max-w-prose mx-auto leading-relaxed">
          Your team agent is bound to your daemon
          {boundRuntimeId ? (
            <>
              {" "}
              (<span className="font-mono text-foreground/70">{boundRuntimeId}</span>)
            </>
          ) : null}
          . Say hi on the next screen — it&apos;ll introduce itself and start
          learning about your work.
        </p>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer text-sm font-medium"
      >
        Meet my team agent
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md text-center text-sm text-muted-foreground space-y-2">
        <MessageSquare className="h-6 w-6 mx-auto text-muted-foreground/60" />
        <div className="text-foreground font-medium">beevibe isn&apos;t connected yet</div>
        <p>
          Set <span className="font-mono">NEXT_PUBLIC_BV_API_URL</span> in{" "}
          <span className="font-mono">.env.local</span>, run{" "}
          <span className="font-mono">pnpm dev</span>, then sign in at{" "}
          <span className="font-mono">/sign-in</span>.
        </p>
      </div>
    </div>
  );
}
