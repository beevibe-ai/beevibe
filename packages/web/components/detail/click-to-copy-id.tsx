"use client";

import { useState } from "react";
import { Check, Copy, Hash } from "lucide-react";

export function ClickToCopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
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
