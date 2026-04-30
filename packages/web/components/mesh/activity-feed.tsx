import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  Ban,
  Check,
  GitPullRequest,
  Link as LinkIcon,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { sessionHref } from "@/lib/format";
import { LoadOlderButton } from "@/components/load-older-button";
import { RichTextRender } from "@/components/rich-text";
import {
  fixtureMeshAsks,
  fixtureMeshAsksOlderCount,
  type MeshAsk,
} from "@/lib/fixtures/mesh";

const TYPE_ICON = {
  ask: LinkIcon,
  negotiate: GitPullRequest,
  blocker: AlertTriangle,
} as const;

export function MeshActivityFeed() {
  return (
    <section className="col-span-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">Recent asks</h2>
        <div className="flex items-center gap-1 text-xs">
          <button className="px-2 py-1 rounded bg-secondary text-foreground font-medium">All</button>
          <button className="px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            ask
          </button>
          <button className="px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            negotiate
          </button>
          <button className="px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            blocker
          </button>
        </div>
      </div>
      <div className="space-y-1">
        {fixtureMeshAsks.map((ask) => (
          <AskCard key={ask.id} ask={ask} />
        ))}
      </div>
      <LoadOlderButton label={`Load ${fixtureMeshAsksOlderCount} older asks`} />
    </section>
  );
}

function AskCard({ ask }: { ask: MeshAsk }) {
  const TypeIcon = TYPE_ICON[ask.type];
  const isLive = ask.status === "in_flight";
  const isBlocked = ask.status === "blocked";
  const ArrowIcon = ask.arrow === "up" ? ArrowUp : ArrowRight;
  const href = ask.source_session ? sessionHref(ask.source_session) : "#";

  return (
    <Link
      href={href}
      className={cn(
        "block rounded-lg border p-3 transition-colors cursor-pointer",
        isLive
          ? "border-status-running/40 bg-status-running/5 hover:border-ring"
          : isBlocked
            ? "border-status-blocked/40 bg-status-blocked/5 hover:border-ring"
            : "border-border bg-card hover:border-ring/40",
      )}
    >
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="font-mono text-foreground">{ask.caller}</span>
        <ArrowIcon
          className={cn(
            "h-3 w-3",
            isLive
              ? "text-status-running"
              : isBlocked
                ? "text-status-blocked"
                : "text-muted-foreground",
          )}
        />
        <span className="font-mono text-foreground">{ask.target}</span>
        {ask.intermediate ? (
          <>
            <span className="text-muted-foreground/60">→</span>
            <span className="font-mono text-muted-foreground">{ask.intermediate}</span>
          </>
        ) : null}
        <StatusBadge ask={ask} />
      </div>
      <p className="text-sm leading-relaxed text-foreground/85">
        <RichTextRender value={ask.intent} />
      </p>
      {ask.response ? (
        <div className="mt-2 rounded bg-secondary/40 p-2 text-xs leading-relaxed">
          <span className="text-muted-foreground">{ask.response.agent} →</span>{" "}
          <span className="text-foreground/85">
            <RichTextRender value={ask.response.content} />
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground font-mono">
        <span className="inline-flex items-center gap-1">
          <TypeIcon className="h-3 w-3" />
          type: {ask.type_label ?? ask.type}
        </span>
        <span className="text-border">·</span>
        <span className={cn(ask.chain_depth_color === "review" && "text-status-review")}>
          chain depth {ask.chain_depth}
        </span>
        <span className="text-border">·</span>
        <SourceMeta ask={ask} />
      </div>
    </Link>
  );
}

function SourceMeta({ ask }: { ask: MeshAsk }) {
  if (ask.awaiting_label) {
    return (
      <span>
        {ask.awaiting_label}{" "}
        {ask.awaiting_task_short_id ? (
          <Link
            href={`/tasks/${ask.awaiting_task_short_id}`}
            className="hover:text-foreground transition-colors"
          >
            {ask.awaiting_task_short_id}
          </Link>
        ) : null}{" "}
        review
      </span>
    );
  }
  return (
    <span>
      session {ask.source_session}
      {ask.source_task_age ? ` · ${ask.source_task_age}` : null}
      {!ask.source_task_age && ask.source_task_short_id ? (
        <>
          {" "}
          · from{" "}
          <span className="hover:text-foreground transition-colors">
            {ask.source_task_short_id}
          </span>
        </>
      ) : null}
    </span>
  );
}

const BADGE_VARIANT: Record<
  MeshAsk["status"],
  { Icon: typeof Loader2; tone: string; spin?: boolean }
> = {
  in_flight: { Icon: Loader2, tone: "bg-status-running/10 text-status-running", spin: true },
  blocked: { Icon: Ban, tone: "bg-status-blocked/10 text-status-blocked" },
  succeeded: { Icon: Check, tone: "bg-status-done/10 text-status-done" },
};

function StatusBadge({ ask }: { ask: MeshAsk }) {
  const { Icon, tone, spin } = BADGE_VARIANT[ask.status];
  return (
    <span
      className={cn(
        "ml-auto inline-flex items-center gap-1 h-5 px-2 rounded text-[10px] font-medium",
        tone,
      )}
    >
      <Icon className={cn("h-3 w-3", spin && "animate-spin-slow")} />
      {ask.duration_label}
    </span>
  );
}
