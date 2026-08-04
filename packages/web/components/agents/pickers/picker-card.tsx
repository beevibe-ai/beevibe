"use client";

import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/keys";
import { cn } from "@/lib/utils";

/**
 * The mutation every agent-setting picker runs: POST the new value, then
 * bump both caches that render agents.
 *
 * The list view consumes data via `useAgentNetwork()` — a separate cache
 * slot (`["agent-network", …]`) from the per-agent detail (`["agents", …]`).
 * Invalidating only one leaves the other stale, so a mutation appears to
 * silently do nothing in whichever view didn't get its key bumped. Four
 * copies of this hook existed (runtime, review-policy, model, and a second
 * inline copy inside `ModelPicker`); one of them also invalidated
 * `agents.detail(id)`, which is redundant — `agents.all` is `["agents"]`
 * and TanStack matches query keys by prefix, so it already covers detail.
 */
export function useAgentSettingMutation<TValue>(
  mutationFn: (value: TValue) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentNetwork.all });
    },
  });
}

/** Shared chrome for the card-wrapped pickers in the agent detail aside. */
export function PickerCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The "Couldn't update …" line each card shows when its mutation fails. */
export function PickerError({ children }: { children: ReactNode }) {
  return <p className="text-xs text-destructive mt-1.5">{children}</p>;
}

/** The muted help copy below a picker's control. */
export function PickerHelp({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p className={cn("text-[11px] text-muted-foreground mt-2 leading-snug", className)}>
      {children}
    </p>
  );
}

/** Native `<select>` chrome, identical across all three card pickers. */
export const PICKER_SELECT_CLASS = cn(
  "w-full text-sm rounded border border-border bg-background px-2 py-1.5",
  "cursor-pointer disabled:opacity-50",
);
