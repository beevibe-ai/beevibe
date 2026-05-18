"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/api/types";

// Common Claude model aliases the CLI accepts. The empty-string sentinel
// represents "CLI default" — clears `runtime_config.model` server-side.
export const MODEL_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "CLI default (recommended)" },
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
  { value: "haiku", label: "haiku" },
];

/**
 * Bare model `<select>` for table cells. With `allowCustom: true` (the
 * card variant) an "Other (pinned model ID)…" option appears, which
 * reveals a tiny inline form for typing a model ID like
 * `claude-opus-4-7`. Compact callers (list rows) leave it off so
 * picking a value never expands the row height.
 */
export function ModelSelect({
  agent,
  className,
  allowCustom = true,
}: {
  agent: AgentDisplay;
  className?: string;
  allowCustom?: boolean;
}) {
  const queryClient = useQueryClient();
  const current = agent.model ?? "";
  const isPreset = MODEL_PRESETS.some((p) => p.value === current);

  const [customMode, setCustomMode] = useState(
    () => allowCustom && !isPreset && current !== "",
  );
  const [customValue, setCustomValue] = useState(() =>
    isPreset ? "" : current,
  );

  useEffect(() => {
    const nextIsPreset = MODEL_PRESETS.some((p) => p.value === current);
    setCustomMode(allowCustom && !nextIsPreset && current !== "");
    setCustomValue(nextIsPreset ? "" : current);
  }, [current, allowCustom]);

  const mutation = useMutation({
    mutationFn: (model: string | null) => api.agents.setModel(agent.id, model),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent.id),
      });
      // List view consumes AgentDisplay.model from the agents list query,
      // not the per-agent detail. Invalidate the list scope too so a row
      // re-renders after mutation.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    },
  });

  // When a non-preset value comes back from the server but allowCustom
  // is off, the select can't represent it — surface as a flat label so
  // the user still sees what's set instead of a blank dropdown.
  if (!allowCustom && !isPreset && current !== "") {
    return (
      <span className="text-xs font-mono text-muted-foreground" title={current}>
        {current}
      </span>
    );
  }

  return (
    <>
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
          mutation.mutate(v === "" ? null : v);
        }}
        className={cn(
          "w-full text-sm rounded border border-border bg-background px-2 py-1.5 cursor-pointer disabled:opacity-50",
          className,
        )}
      >
        {MODEL_PRESETS.map((p) => (
          <option key={p.value || "__default"} value={p.value}>
            {p.label}
          </option>
        ))}
        {allowCustom ? (
          <option value="__custom">Other (pinned model ID)…</option>
        ) : null}
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
    </>
  );
}

/**
 * Card-wrapped model picker for the agent detail aside.
 */
export function ModelPicker({ agent }: { agent: AgentDisplay }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        Model
      </h3>
      <ModelSelect agent={agent} />
      <p className="text-[11px] text-muted-foreground mt-2 leading-snug">
        Model alias passed to the CLI via <span className="font-mono">--model</span>.
        Leave on &quot;CLI default&quot; to inherit whatever you&apos;ve
        configured in <span className="font-mono">~/.claude</span>.
      </p>
    </section>
  );
}
