"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Loader2,
  MessageSquare,
  Minus,
  Network,
  Sparkles,
  X,
} from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { useLlmHealth, useMe } from "@/lib/hooks/use-me";
import { cn } from "@/lib/utils";

type Step = "intro" | "providers" | "ready";

export function WelcomeClient() {
  const router = useRouter();
  const { data: me, isLoading } = useMe();
  const [step, setStep] = useState<Step>("intro");

  // Already onboarded — drop straight into chat. The /me query is the
  // source of truth so a stale browser tab can't accidentally re-show
  // the wizard after a fresh chat completed it.
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
          <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center">
            <span className="text-primary-foreground text-[13px] font-bold leading-none">b</span>
          </div>
          <span className="text-sm font-semibold tracking-tight">beevibe</span>
          <Stepper current={step} className="ml-auto" />
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        {/* `key` re-mounts the inner div on step change so the
            entrance animation re-fires; the wizard reads as three
            distinct moments instead of three snapshots. */}
        <div
          key={step}
          className="max-w-2xl w-full motion-safe:animate-[wizard-step_180ms_ease-out_both]"
        >
          {step === "intro" ? <IntroStep onNext={() => setStep("providers")} /> : null}
          {step === "providers" ? <ProvidersStep onNext={() => setStep("ready")} /> : null}
          {step === "ready" ? (
            <ReadyStep onContinue={() => router.replace("/?from=welcome")} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function Stepper({ current, className }: { current: Step; className?: string }) {
  const steps: Step[] = ["intro", "providers", "ready"];
  const idx = steps.indexOf(current);
  return (
    <div className={cn("flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground", className)}>
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-1.5">
          <span
            className={cn(
              "h-2 w-2 rounded-full transition-colors",
              i <= idx ? "bg-primary" : "bg-muted-foreground/50",
            )}
          />
          {i < steps.length - 1 ? (
            <span className={cn("h-0.5 w-5 rounded-full transition-colors", i < idx ? "bg-primary" : "bg-muted-foreground/40")} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function IntroStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-8">
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to beevibe.</h1>
        <p className="text-base text-muted-foreground max-w-prose mx-auto leading-relaxed">
          beevibe is a team of AI agents you manage by chatting with them.
          You talk to your team agent; it spawns subordinates to do the work.
        </p>
      </div>

      <FlowDiagram />

      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer text-sm font-medium"
        >
          Set up my team agent
          <ArrowRight className="h-4 w-4" />
        </button>
        <p className="text-xs text-muted-foreground">~30 seconds. No account needed.</p>
      </div>
    </div>
  );
}

function FlowDiagram() {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-6 text-center">
      <div className="flex items-center justify-around">
        <DiagramNode icon={MessageSquare} label="You" caption="chat" />
        <Arrow />
        <DiagramNode icon={Sparkles} label="Team agent" caption="orchestrates" highlight />
        <Arrow />
        <DiagramNode icon={Network} label="Subordinates" caption="execute" />
      </div>
      <p className="mt-5 text-xs text-muted-foreground max-w-md mx-auto">
        Your team agent has full hierarchy tool access — it can mint tasks, query the
        fleet, and surface results back to you in this chat.
      </p>
    </div>
  );
}

function DiagramNode({
  icon: Icon,
  label,
  caption,
  highlight,
}: {
  icon: typeof MessageSquare;
  label: string;
  caption: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={cn(
          "h-12 w-12 rounded-full flex items-center justify-center border",
          highlight
            ? "bg-primary border-primary text-primary-foreground"
            : "bg-secondary border-border text-foreground",
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-xs font-medium">{label}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{caption}</div>
    </div>
  );
}

function Arrow() {
  return <ArrowRight className="h-4 w-4 text-muted-foreground/60 shrink-0" />;
}

function ProvidersStep({ onNext }: { onNext: () => void }) {
  const { data, isLoading, isError, refetch, isFetching } = useLlmHealth();

  // Only the Claude CLI is a hard requirement — chat goes through the
  // claude subprocess on every turn. OpenAI is optional: when it's
  // absent or failing, memory recall is disabled but the team agent
  // still chats fine. Don't gate the wizard on OpenAI.
  const canProceed = data?.claude_cli.ok === true;
  const openaiDegraded = !!data && !data.openai.ok && !data.openai.skipped;

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold">Runtime check</h2>
        <p className="text-sm text-muted-foreground max-w-prose mx-auto">
          Your team agent runs as a <span className="font-mono">claude</span> CLI
          subprocess; OpenAI powers its memory recall. We&apos;ll verify both before
          dropping you into chat.
        </p>
      </div>

      <div className="space-y-2 max-w-md mx-auto">
        <ProviderRow
          label="Claude CLI"
          subtitle="spawned per chat turn (uses ~/.claude/ login)"
          state={isLoading ? "loading" : data?.claude_cli.ok ? "ok" : "fail"}
          message={data?.claude_cli.ok ? undefined : data?.claude_cli.message}
        />
        <ProviderRow
          label="OpenAI"
          subtitle={
            data?.openai.skipped
              ? "memory disabled (optional — add OPENAI_API_KEY in .env to enable)"
              : "memory recall (text-embedding-3-small)"
          }
          state={
            isLoading
              ? "loading"
              : data?.openai.skipped
              ? "skipped"
              : data?.openai.ok
              ? "ok"
              : "fail"
          }
          message={data?.openai.ok ? undefined : data?.openai.message}
        />
      </div>

      {isError ? (
        <div className="rounded-lg border border-status-failed/40 bg-status-failed/5 p-3 text-xs max-w-md mx-auto">
          <div className="flex items-center gap-1.5 text-status-failed font-medium mb-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            Couldn&apos;t reach the api server
          </div>
          <div className="text-muted-foreground">
            Make sure <span className="font-mono">pnpm dev</span> is running and{" "}
            <span className="font-mono">NEXT_PUBLIC_BV_API_URL</span> /{" "}
            <span className="font-mono">NEXT_PUBLIC_BV_USER_KEY</span> are set.
          </div>
        </div>
      ) : null}

      {data && !data.claude_cli.ok ? (
        <div className="rounded-lg border border-status-failed/40 bg-status-failed/5 p-3 text-xs max-w-md mx-auto">
          <div className="text-status-failed font-medium mb-1">Claude CLI not found</div>
          <div className="text-muted-foreground">
            Install Claude Code (<span className="font-mono">claude</span> on your{" "}
            <span className="font-mono">PATH</span>) and run{" "}
            <span className="font-mono">claude login</span> on the host where the api
            server runs, then re-check.
          </div>
        </div>
      ) : null}

      {openaiDegraded ? (
        <div className="rounded-lg border border-status-review/40 bg-status-review/5 p-3 text-xs max-w-md mx-auto">
          <div className="text-status-review font-medium mb-1">
            OpenAI key not working — memory will be off
          </div>
          <div className="text-muted-foreground">
            Chat still works without it; the team agent just won&apos;t recall
            facts across sessions. To enable memory: update{" "}
            <span className="font-mono">OPENAI_API_KEY</span> in{" "}
            <span className="font-mono">.env</span> (or clear it to
            silence this warning), restart <span className="font-mono">pnpm dev</span>,
            then re-check. Or continue and fix it later.
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border hover:bg-secondary transition-colors text-sm disabled:opacity-50 cursor-pointer"
        >
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Re-check
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canProceed}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-sm font-medium"
        >
          Continue
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ProviderRow({
  label,
  subtitle,
  state,
  message,
}: {
  label: string;
  subtitle: string;
  state: "loading" | "ok" | "fail" | "skipped";
  message?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3 flex items-center gap-3">
      <StatusGlyph state={state} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{subtitle}</div>
        {message ? (
          <div className="text-[11px] text-status-failed mt-1 truncate" title={message}>
            {message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatusGlyph({ state }: { state: "loading" | "ok" | "fail" | "skipped" }) {
  if (state === "loading") {
    return (
      <div className="h-7 w-7 rounded-full bg-secondary border border-border flex items-center justify-center">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (state === "ok") {
    return (
      <div className="h-7 w-7 rounded-full bg-status-done/15 border border-status-done/40 flex items-center justify-center">
        <Check className="h-3.5 w-3.5 text-status-done" />
      </div>
    );
  }
  if (state === "skipped") {
    return (
      <div className="h-7 w-7 rounded-full bg-secondary border border-border flex items-center justify-center">
        <Minus className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
    );
  }
  return (
    <div className="h-7 w-7 rounded-full bg-status-failed/15 border border-status-failed/40 flex items-center justify-center">
      <X className="h-3.5 w-3.5 text-status-failed" />
    </div>
  );
}

function ReadyStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="space-y-6 text-center">
      <div className="space-y-3">
        <div className="mx-auto h-12 w-12 rounded-full bg-status-done/15 border border-status-done/40 flex items-center justify-center">
          <Sparkles className="h-5 w-5 text-status-done" />
        </div>
        <h2 className="text-xl font-semibold">You&apos;re set.</h2>
        <p className="text-sm text-muted-foreground max-w-prose mx-auto leading-relaxed">
          Your team agent will introduce itself and ask you a few questions on the next
          screen so it can save what it learns into its memory. Answer naturally — it
          watches you type and writes to memory live.
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
          Set <span className="font-mono">NEXT_PUBLIC_BV_API_URL</span> +{" "}
          <span className="font-mono">NEXT_PUBLIC_BV_USER_KEY</span> in your{" "}
          <span className="font-mono">.env</span> and run{" "}
          <span className="font-mono">pnpm dev</span> to get started.
        </p>
      </div>
    </div>
  );
}
