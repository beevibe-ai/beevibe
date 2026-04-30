import { Bot, CheckCircle2, Terminal, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "@/lib/fixtures/sessions";

const KIND_CONFIG = {
  agent: { Icon: Bot, color: "text-foreground", bg: "bg-secondary/40" },
  tool_call: { Icon: Wrench, color: "text-status-running", bg: "" },
  tool_result: { Icon: Terminal, color: "text-muted-foreground", bg: "" },
  summary: { Icon: CheckCircle2, color: "text-status-done", bg: "bg-status-done/10" },
} as const;

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
        Transcript
      </h3>
      <div className="space-y-3">
        {entries.map((entry, i) => {
          const config = KIND_CONFIG[entry.kind];
          const Icon = config.Icon;
          return (
            <div
              key={i}
              className={cn(
                "flex items-start gap-3 px-3 py-2 rounded -mx-3",
                config.bg,
              )}
            >
              <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", config.color)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                    {entry.timestamp}
                  </span>
                  {entry.tool_name ? (
                    <span className="font-mono text-[10px] text-status-running">
                      {entry.tool_name}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm leading-relaxed">{entry.content}</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
