"use client";

import { useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";

/**
 * Labeled shell command with an inline copy button. Used by the welcome
 * wizard's daemon-install step and the runtimes panel's empty state /
 * "set up another machine" disclosure — both want the same affordance:
 * "here's the command, click to copy."
 *
 * The clipboard write is a no-op when `navigator.clipboard` is missing
 * (older browsers / non-https origins) so the button still looks live
 * without throwing.
 */
export function CommandBlock({
  label,
  command,
}: {
  label: string;
  command: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="rounded-md border border-border bg-card overflow-hidden text-left">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-secondary/30">
        <Terminal className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          {label}
        </span>
        <button
          type="button"
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-status-done" />
              copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              copy
            </>
          )}
        </button>
      </div>
      <code className="block px-3 py-2.5 text-xs font-mono text-foreground/85 overflow-x-auto whitespace-pre">
        {command}
      </code>
    </div>
  );
}
