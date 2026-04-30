"use client";

import { ChevronsUpDown } from "lucide-react";

// Stage 2 placeholder: hardcoded Weijia. Replaced in stage 3 with the
// real caller from /api/auth/me (or whatever the MCP server exposes).
export function UserWidget() {
  return (
    <button
      type="button"
      aria-label="User menu — Weijia"
      className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded hover:bg-secondary cursor-pointer transition-colors text-left"
    >
      <div className="h-7 w-7 rounded-full bg-secondary border border-border flex items-center justify-center text-xs font-medium shrink-0">
        W
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate leading-tight">Weijia</div>
        <div className="text-[10px] text-muted-foreground flex items-center gap-1 leading-tight mt-0.5">
          <span className="inline-block h-1 w-1 rounded-full bg-status-running animate-pulse-breathe" />
          live
        </div>
      </div>
      <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    </button>
  );
}
