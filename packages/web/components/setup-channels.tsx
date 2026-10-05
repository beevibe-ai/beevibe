"use client";

import { useState, type ReactNode } from "react";
import { CommandBlock } from "@/components/command-block";
import { SegmentedTabs, type SegmentedTabOption } from "@/components/segmented-tabs";
import { cn } from "@/lib/utils";

/** One copy-pasteable command, with the label shown above it. */
export interface SetupStep {
  label: string;
  command: string;
}

/**
 * The commands for one channel, plus the prose that frames them.
 *
 * `prelude` goes above the commands (what file to edit, where to download
 * from); `epilogue` goes below (what to do once they've run).
 */
export interface SetupBundle {
  prelude?: ReactNode;
  steps: readonly SetupStep[];
  epilogue?: ReactNode;
}

/**
 * "Pick your channel, here are the commands" — the shape both setup
 * disclosures in the app have: the daemon installer (brew / npx / direct
 * download) and the MCP client instructions (Claude Code / Codex / opencode
 * / manual).
 *
 * `SegmentedTabs` was already shared between the two, but everything around
 * it had been written twice: the `{label, command}` step type, the
 * `{prelude, steps, epilogue}` bundle type, the `useState` holding the
 * selected channel, and the render body that lays out tabs → prelude →
 * numbered `CommandBlock`s → epilogue. Only the channel list and the
 * per-channel command text ever differed, so those are the props and the
 * rest lives here.
 *
 * `buildBundle` is called on every render rather than memoized: it is a
 * handful of template strings, and the inputs (api base url, user key) are
 * read from module state that can change between renders.
 */
export function SetupChannels<T extends string>({
  options,
  initial,
  buildBundle,
  numbering = "always",
  className,
}: {
  options: readonly SegmentedTabOption<T>[];
  /**
   * The channel selected on first render. Pass a function when the choice
   * depends on the browser (the daemon installer sniffs the platform) so it
   * runs once on mount rather than on every render.
   */
  initial: T | (() => T);
  buildBundle: (channel: T) => SetupBundle;
  /**
   * `"always"` prefixes every command with its step number. `"multi-step"`
   * numbers them only when a channel has more than one — a lone command
   * reads better as "Register the beevibe MCP server" than "1. Register
   * the beevibe MCP server".
   */
  numbering?: "always" | "multi-step";
  className?: string;
}) {
  const [channel, setChannel] = useState<T>(initial);
  const bundle = buildBundle(channel);
  const numbered = numbering === "always" || bundle.steps.length > 1;

  return (
    <div className={cn("space-y-3", className)}>
      <SegmentedTabs options={options} value={channel} onChange={setChannel} />
      <div className="space-y-2">
        {bundle.prelude}
        {bundle.steps.map((step, i) => (
          <CommandBlock
            key={i}
            label={numbered ? `${i + 1}. ${step.label}` : step.label}
            command={step.command}
          />
        ))}
        {bundle.epilogue}
      </div>
    </div>
  );
}
