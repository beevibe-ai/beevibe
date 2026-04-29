import { ArrowRight, ArrowUpRight, Ban, Check, CheckCircle2, GitPullRequest, PlusCircle } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { cn } from "@/lib/utils";
import { fixtureThreadEvents, type ThreadEvent } from "@/lib/fixtures/thread-messages";

const SYS_ICON = {
  "plus-circle": PlusCircle,
  "arrow-right": ArrowRight,
  check: Check,
} as const;

export function ThreadTimeline() {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="max-w-3xl mx-auto space-y-1">
        {fixtureThreadEvents.map((event, i) => (
          <EventRow key={i} event={event} />
        ))}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: ThreadEvent }) {
  if (event.kind === "date_separator") {
    return (
      <div className="flex items-center gap-3 py-3 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="flex-1 h-px bg-border" />
        <span>{event.label}</span>
        <span className="flex-1 h-px bg-border" />
      </div>
    );
  }

  if (event.kind === "system") {
    const Icon = SYS_ICON[event.iconName];
    return (
      <div className="text-xs text-muted-foreground py-1.5 px-2 flex items-center gap-2">
        <Icon className="h-3 w-3" />
        <span>{event.content}</span>
        <span className="text-border ml-auto">{event.timestamp}</span>
      </div>
    );
  }

  if (event.kind === "session_start") {
    const author = event.author;
    if (author.kind === "person") return null;
    return (
      <div className="flex gap-3 py-2 px-2 rounded hover:bg-secondary/30 transition-colors">
        <Avatar
          initial={author.initial}
          kind={author.hierarchy}
          presence={event.presence}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm">{author.name}</span>
            <HierChip hier={author.hierarchy} />
            <span className="text-[10px] text-muted-foreground">
              started session <span className="font-mono">{event.session_short_id}</span>
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {event.timestamp}
            </span>
          </div>
          <p className="mt-0.5 text-sm leading-6 text-muted-foreground italic">{event.intent}</p>
        </div>
      </div>
    );
  }

  if (event.kind === "session_result") {
    const author = event.author;
    if (author.kind === "person") return null;
    return (
      <div className="flex gap-3 py-2 px-2 rounded hover:bg-secondary/30 transition-colors">
        <Avatar initial={author.initial} kind={author.hierarchy} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm">{author.name}</span>
            <CheckCircle2 className="h-3 w-3 text-status-done" />
            <span className="text-[10px] text-muted-foreground">{event.duration_label}</span>
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {event.timestamp}
            </span>
          </div>
          <p className="mt-0.5 text-sm leading-6">{event.content}</p>
          {event.work_product ? (
            <button className="mt-2 inline-flex items-center gap-2 px-2.5 py-1.5 rounded border border-border hover:border-ring transition-colors group cursor-pointer">
              <GitPullRequest className="h-3.5 w-3.5 text-status-running" />
              <span className="text-xs font-medium">{event.work_product.label}</span>
              <span className="text-xs text-muted-foreground">{event.work_product.title}</span>
              <ArrowUpRight className="h-3 w-3 text-muted-foreground group-hover:text-foreground" />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (event.kind === "blocker") {
    const author = event.author;
    if (author.kind === "person") return null;
    return (
      <div
        className="my-1 px-3 py-2.5 rounded-md flex gap-3"
        style={{ background: "hsl(var(--status-blocked) / 0.08)" }}
      >
        <Avatar initial={author.initial} kind={author.hierarchy} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm">{author.name}</span>
            <span className="inline-flex items-center gap-1 text-status-blocked text-xs font-medium">
              <Ban className="h-3 w-3" />
              raised a blocker
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {event.timestamp}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6">{event.content}</p>
          <div className="mt-1.5 text-[10px] text-muted-foreground">{event.blocker_meta}</div>
        </div>
      </div>
    );
  }

  if (event.kind === "human_reply") {
    const author = event.author;
    if (author.kind !== "person") return null;
    return (
      <div className="flex gap-3 py-2 px-2 rounded hover:bg-secondary/30 transition-colors">
        <Avatar initial={author.initial} kind="person" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm">{author.name}</span>
            {event.cleared_blocker ? (
              <>
                <Check className="h-3 w-3 text-status-done" />
                <span className="text-[10px] text-muted-foreground">cleared the blocker</span>
              </>
            ) : null}
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {event.timestamp}
            </span>
          </div>
          <p className={cn("mt-0.5 text-sm leading-6")}>{event.content}</p>
        </div>
      </div>
    );
  }

  return null;
}
