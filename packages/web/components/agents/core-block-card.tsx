import { Pencil } from "lucide-react";
import type { CoreBlockDisplay } from "@/lib/fixtures/core-memory-blocks";

export function CoreBlockCard({ block }: { block: CoreBlockDisplay }) {
  const filled = (block.char_count / block.char_limit) * 88;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          <svg className="h-12 w-12" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="14" fill="none" stroke="hsl(var(--border))" strokeWidth="2.5" />
            <circle
              cx="18"
              cy="18"
              r="14"
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth="2.5"
              strokeDasharray={`${filled.toFixed(1)} 88`}
              transform="rotate(-90 18 18)"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="font-mono text-xs font-medium">{block.block_name}</span>
            <span className="text-[10px] text-muted-foreground">
              {block.char_count.toLocaleString()} / {block.char_limit.toLocaleString()} chars
            </span>
            <button
              aria-label={`Edit ${block.block_name} block`}
              className="ml-auto h-5 w-5 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
          <p className="text-sm text-foreground/85 leading-relaxed">{block.content}</p>
          <div className="mt-2 text-[10px] text-muted-foreground">{block.updated_label}</div>
        </div>
      </div>
    </div>
  );
}
