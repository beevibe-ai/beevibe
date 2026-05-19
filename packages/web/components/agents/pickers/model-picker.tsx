"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import {
  ChipCaret,
  ChipMenuItem,
  ChipPopover,
} from "@/components/agents/pickers/chip-popover";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/api/types";

// Common Claude model aliases the CLI accepts. The empty-string sentinel
// represents "CLI default" — clears `runtime_config.model` server-side.
export const MODEL_PRESETS: ReadonlyArray<{
  value: string;
  label: string;
  sublabel?: string;
}> = [
  { value: "", label: "CLI default", sublabel: "from ~/.claude" },
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
  { value: "haiku", label: "haiku" },
];

function useModelMutation(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (model: string | null) => api.agents.setModel(agentId, model),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agentId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentNetwork.all });
    },
  });
}

function presetLabel(value: string): string | undefined {
  return MODEL_PRESETS.find((p) => p.value === value)?.label;
}

/**
 * Chip-style model picker for the agent list view. Muted gray pill in
 * the resting state — model choice is rarely the load-bearing setting
 * compared to runtime, so it gets visual second billing. Click opens a
 * popover with the four common presets; custom pinned model IDs are
 * available via the detail page's full picker (not duplicated here so
 * row height stays stable).
 */
export function ModelChip({ agent }: { agent: AgentDisplay }) {
  const mutation = useModelMutation(agent.id);
  const current = agent.model ?? "";
  const label = presetLabel(current) ?? current ?? "CLI default";
  const isDefault = current === "";

  return (
    <ChipPopover
      ariaLabel={`Model: ${label}. Click to change.`}
      chipClassName={cn(
        "border border-border bg-transparent hover:bg-secondary/60",
        isDefault ? "text-muted-foreground italic" : "text-foreground/90",
      )}
      disabled={mutation.isPending}
      chip={
        <>
          <span className="font-mono text-[11.5px] tabular-nums">{label}</span>
          <ChipCaret />
        </>
      }
    >
      {(close) => (
        <>
          {MODEL_PRESETS.map((p) => (
            <ChipMenuItem
              key={p.value || "__default"}
              selected={p.value === current}
              label={
                <span className={cn("text-[13px]", p.value === "" ? "italic" : "font-mono")}>
                  {p.label}
                </span>
              }
              sublabel={p.sublabel}
              onClick={() => {
                mutation.mutate(p.value === "" ? null : p.value);
                close();
              }}
            />
          ))}
          {current && !MODEL_PRESETS.some((p) => p.value === current) ? (
            <>
              <div className="my-1 border-t border-border" />
              <ChipMenuItem
                selected
                label={
                  <span className="text-[13px] font-mono">{current}</span>
                }
                sublabel="pinned"
                onClick={() => close()}
              />
            </>
          ) : null}
          <div className="my-1 border-t border-border" />
          <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground/80">
            Pin a custom model ID from the agent&apos;s detail page.
          </div>
        </>
      )}
    </ChipPopover>
  );
}

/**
 * Card-wrapped model picker for the agent detail aside. Keeps the
 * full-width native `<select>` plus the "Other (pinned model ID)…"
 * custom-text path that the chip variant intentionally drops. The
 * detail page is where users do substantive config; the list view is
 * for quick toggles.
 */
export function ModelPicker({ agent }: { agent: AgentDisplay }) {
  const queryClient = useQueryClient();
  const current = agent.model ?? "";
  const isPreset = MODEL_PRESETS.some((p) => p.value === current);

  const [customMode, setCustomMode] = useState(
    () => !isPreset && current !== "",
  );
  const [customValue, setCustomValue] = useState(() =>
    isPreset ? "" : current,
  );

  useEffect(() => {
    const nextIsPreset = MODEL_PRESETS.some((p) => p.value === current);
    setCustomMode(!nextIsPreset && current !== "");
    setCustomValue(nextIsPreset ? "" : current);
  }, [current]);

  const mutation = useMutation({
    mutationFn: (model: string | null) => api.agents.setModel(agent.id, model),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentNetwork.all });
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
          mutation.mutate(v === "" ? null : v);
        }}
        className="w-full text-sm rounded border border-border bg-background px-2 py-1.5 cursor-pointer disabled:opacity-50"
      >
        {MODEL_PRESETS.map((p) => (
          <option key={p.value || "__default"} value={p.value}>
            {p.label}
            {p.value === "" ? " (recommended)" : ""}
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
