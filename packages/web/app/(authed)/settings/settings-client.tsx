"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Cpu, Sparkles } from "lucide-react";
import {
  api,
  type MeResponse,
  type UserPreferences,
} from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";

export function SettingsClient() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery<MeResponse>({
    queryKey: queryKeys.me.self(),
    queryFn: ({ signal }) => api.me.self({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });

  const toggle = useMutation({
    mutationFn: (input: Partial<UserPreferences>) => api.me.updatePreferences(input),
    onSuccess: (res) => {
      qc.setQueryData<MeResponse>(queryKeys.me.self(), (prev) =>
        prev ? { ...prev, preferences: res.preferences } : prev,
      );
    },
  });

  if (!isApiConfigured) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <EmptyState title="API not configured" description="Set NEXT_PUBLIC_BV_API_URL." />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Per-user preferences and feature toggles.
          </p>
        </header>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Features
            </h2>
          </div>
          {isLoading ? (
            <Skeleton className="h-20 w-full rounded-lg" />
          ) : isError || !data ? (
            <EmptyState
              title="Couldn't load preferences"
              description="Try refreshing the page."
            />
          ) : (
            <CapabilityNetworkToggle
              enabled={data.preferences.capability_network_enabled}
              onToggle={(next) => toggle.mutate({ capability_network_enabled: next })}
              isPending={toggle.isPending}
              errored={toggle.isError}
            />
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Other
          </h2>
          <Link
            href="/runtimes"
            className="block rounded-lg border border-border/40 bg-card hover:bg-secondary/30 transition-colors px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <Cpu className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Runtimes</p>
                <p className="text-xs text-muted-foreground">
                  beevibe-daemon status, registered CLIs, and install instructions.
                </p>
              </div>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
          </Link>
        </section>
      </div>
    </div>
  );
}

function CapabilityNetworkToggle({
  enabled,
  onToggle,
  isPending,
  errored,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  isPending: boolean;
  errored: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Capability network</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            Lets your agents discover and run external GitHub repos in a
            sandbox via <span className="font-mono">find_repo</span> +{" "}
            <span className="font-mono">use_repo</span>. Surfaces the{" "}
            <span className="font-mono">/capabilities</span> page, Try
            buttons on chat repo cards, and the Save-as-capability flow.
            Turn off to hide all of it and strip the tools from your
            agents&apos; tool list.
          </p>
          {errored ? (
            <p className="text-[11px] text-red-500 mt-1">Couldn&apos;t save — try again.</p>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={isPending}
          onClick={() => onToggle(!enabled)}
          className={
            "shrink-0 mt-0.5 inline-flex items-center h-6 w-11 rounded-full transition-colors " +
            "disabled:opacity-50 disabled:cursor-not-allowed " +
            (enabled
              ? "bg-emerald-500/70 hover:bg-emerald-500/90"
              : "bg-muted hover:bg-muted/80")
          }
        >
          <span
            className={
              "inline-block h-5 w-5 rounded-full bg-background shadow transition-transform " +
              (enabled ? "translate-x-[22px]" : "translate-x-[2px]")
            }
          />
        </button>
      </div>
    </div>
  );
}
