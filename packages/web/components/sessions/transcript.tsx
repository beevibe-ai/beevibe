import {
  ArrowDownRight,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  Link as LinkIcon,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { RichTextRender } from "@/components/rich-text";
import type { AskThread, TranscriptEntry } from "@/lib/types/sessions";

const KIND_CONFIG = {
  agent: { Icon: Bot, color: "text-foreground", bg: "bg-secondary/40" },
  tool_call: { Icon: Wrench, color: "text-status-running", bg: "" },
  tool_result: { Icon: Terminal, color: "text-muted-foreground", bg: "" },
  summary: { Icon: CheckCircle2, color: "text-status-done", bg: "bg-status-done/10" },
} as const;

export function Transcript({
  entries,
  ask_threads,
}: {
  entries: TranscriptEntry[];
  ask_threads?: AskThread[];
}) {
  const asksByIndex = new Map<number, AskThread[]>();
  for (const ath of ask_threads ?? []) {
    const arr = asksByIndex.get(ath.insert_after_index) ?? [];
    arr.push(ath);
    asksByIndex.set(ath.insert_after_index, arr);
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
        Transcript
      </h3>
      <div className="space-y-3">
        {entries.map((entry, i) => {
          const config = KIND_CONFIG[entry.kind];
          const Icon = config.Icon;
          const trailingAsks = asksByIndex.get(i) ?? [];
          return (
            <div key={i} className="space-y-3">
              <div
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
                  <p className="text-sm leading-relaxed break-words [overflow-wrap:anywhere]">{entry.content}</p>
                </div>
              </div>
              {trailingAsks.map((ath) => (
                <MeshAskBlock key={ath.id} ask={ath} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MeshAskBlock({ ask }: { ask: AskThread }) {
  const ArrowIcon = ask.arrow === "up" ? ArrowUp : ArrowRight;
  const StatusIcon = ask.status === "succeeded" ? Check : XCircle;
  const tone =
    ask.tone === "running"
      ? "border-status-running/30 bg-status-running/5"
      : "border-border bg-card";
  const linkColor = ask.tone === "running" ? "text-status-running" : "text-muted-foreground";
  const statusTone =
    ask.status === "succeeded"
      ? "bg-status-done/10 text-status-done"
      : "bg-status-failed/10 text-status-failed";

  return (
    <div className={cn("rounded-lg border p-4", tone)}>
      <div className="flex items-center gap-2 mb-3 text-xs">
        <LinkIcon className={cn("h-3.5 w-3.5", linkColor)} />
        <span className="font-medium">Mesh ask</span>
        <span className="font-mono text-foreground">{ask.caller}</span>
        <ArrowIcon className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono text-foreground">{ask.responder}</span>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 h-5 px-2 rounded text-[10px] font-medium",
            statusTone,
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {ask.duration_label}
        </span>
      </div>

      <div className="space-y-2.5 pl-1">
        <div className="flex items-start gap-2">
          <ArrowUpRight className="h-3 w-3 text-muted-foreground mt-1.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm leading-relaxed text-foreground/85">
              <RichTextRender value={ask.request} />
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <ArrowDownRight className="h-3 w-3 text-muted-foreground mt-1.5 shrink-0" />
          <div className="flex-1">
            <div className="text-[10px] text-muted-foreground mb-1">
              <span className="font-mono text-foreground">{ask.response.agent}</span>
              <span> · {ask.response.note ?? "answered from its own bounded memory"}</span>
            </div>
            <p className="text-sm leading-relaxed text-foreground/85">
              <RichTextRender value={ask.response.content} />
            </p>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
        <span>chain depth {ask.chain_depth}</span>
        <span className="text-border">·</span>
        <span>{ask.spawned_session_label}</span>
        {ask.tokens_label ? (
          <>
            <span className="text-border">·</span>
            <span>{ask.tokens_label}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
