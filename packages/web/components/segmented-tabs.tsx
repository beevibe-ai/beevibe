"use client";

import { cn } from "@/lib/utils";

export interface SegmentedTabOption<T extends string> {
  id: T;
  label: string;
  /** Small second line under the label — platform, caveat, audience. */
  hint: string;
}

/**
 * Segmented control with a two-line label, used to pick which set of
 * setup commands to show: the daemon installer's brew/npx/direct
 * channels and the MCP instructions' claude/codex/opencode/manual
 * clients.
 *
 * Both were built from the same block of markup and the same
 * `{id, label, hint}` option shape, down to the `text-[10px]` hint and
 * the selected-state colors.
 */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: readonly SegmentedTabOption<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("flex gap-1 rounded-lg border border-border bg-card p-1", className)}
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={cn(
            "flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer",
            value === opt.id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <div>{opt.label}</div>
          <div className="text-[10px] font-normal opacity-80 mt-0.5">{opt.hint}</div>
        </button>
      ))}
    </div>
  );
}
