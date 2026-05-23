"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Cpu, KeyRound, Sparkles, Trash2 } from "lucide-react";
import {
  api,
  type MeResponse,
  type PersonSecretDisplay,
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
          <div className="flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Secrets
            </h2>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            API keys + tokens your agents can inject into sandboxed{" "}
            <span className="font-mono">use_repo</span> runs (e.g.{" "}
            <span className="font-mono">OPENAI_API_KEY</span> for the
            architecture-deep-research repo). Values are encrypted at rest
            (AES-256-GCM) and only decrypted in-memory at sandbox spawn
            time — never returned to the browser.
          </p>
          <SecretsSection />
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

function SecretsSection() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.secrets.list(),
    queryFn: ({ signal }) => api.secrets.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });

  const secrets = list.data?.secrets ?? [];
  // Touched by both upsert + delete so the list refetches after either.
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: queryKeys.secrets.all });

  if (list.isLoading) return <Skeleton className="h-24 w-full rounded-lg" />;
  if (list.isError) {
    return (
      <EmptyState
        title="Couldn't load secrets"
        description="Try refreshing the page."
      />
    );
  }

  return (
    <div className="space-y-2">
      {secrets.map((s) => (
        <SecretRow key={s.id} secret={s} onDeleted={invalidate} />
      ))}
      <AddSecretForm onAdded={invalidate} />
    </div>
  );
}

function SecretRow({
  secret,
  onDeleted,
}: {
  secret: PersonSecretDisplay;
  onDeleted: () => void;
}) {
  const del = useMutation({
    mutationFn: () => api.secrets.delete(secret.id),
    onSuccess: onDeleted,
  });
  return (
    <div className="rounded-lg border border-border/40 bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-mono text-sm">{secret.name}</p>
          {secret.description ? (
            <p className="text-xs text-muted-foreground mt-0.5">
              {secret.description}
            </p>
          ) : null}
          {del.isError ? (
            <p className="text-[11px] text-red-500 mt-1">
              Delete failed — try again.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => del.mutate()}
          disabled={del.isPending}
          aria-label={`Delete ${secret.name}`}
          className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function AddSecretForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const upsert = useMutation({
    mutationFn: () =>
      api.secrets.upsert({
        name: name.trim(),
        value,
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: () => {
      setName("");
      setValue("");
      setDescription("");
      onAdded();
    },
  });

  // Mirror the api route's validation so the user sees the same rule
  // before round-tripping. The server is still the source of truth.
  const nameValid = /^[A-Z_][A-Z0-9_]*$/.test(name.trim());
  const canSubmit = nameValid && value.length > 0 && !upsert.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) upsert.mutate();
      }}
      className="rounded-lg border border-dashed border-border/50 bg-card/40 px-4 py-3 space-y-2"
    >
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
        Add or rotate
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="OPENAI_API_KEY"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="rounded border border-border/40 bg-background px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value (never shown again)"
          autoComplete="off"
          spellCheck={false}
          className="rounded border border-border/40 bg-background px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What's this for? (optional)"
        maxLength={512}
        className="w-full rounded border border-border/40 bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {name.length > 0 && !nameValid
            ? "Name must be SCREAMING_SNAKE_CASE."
            : upsert.isError
              ? "Save failed — check the name + value."
              : "Re-adding an existing name rotates it."}
        </p>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded bg-foreground text-background text-xs font-medium px-2.5 py-1 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {upsert.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
