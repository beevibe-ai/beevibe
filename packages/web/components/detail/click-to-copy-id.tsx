"use client";

import { Check, Copy, Hash } from "lucide-react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

export function ClickToCopyId({ id }: { id: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      onClick={() => void copy(id)}
      className="inline-flex items-center gap-1.5 font-mono hover:text-foreground transition-colors cursor-pointer"
      title="Copy ID"
      aria-label={copied ? "ID copied" : `Copy ID ${id}`}
    >
      <Hash className="h-3 w-3" />
      {id}
      {copied ? <Check className="h-3 w-3 text-status-done" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
