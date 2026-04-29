import Link from "next/link";
import { AlertCircle, Ban, Loader2, Plus } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { cn } from "@/lib/utils";
import {
  fixtureThreadSections,
  type ThreadChannel,
} from "@/lib/fixtures/thread-messages";

const STATUS_ICON: Record<
  ThreadChannel["status"],
  { Icon: typeof AlertCircle; color: string; spin?: boolean }
> = {
  review: { Icon: AlertCircle, color: "text-status-review" },
  running: { Icon: Loader2, color: "text-status-running", spin: true },
  blocked: { Icon: Ban, color: "text-status-blocked" },
};

export function ChannelRail() {
  return (
    <aside className="w-[280px] shrink-0 bg-secondary/30 flex flex-col overflow-hidden border-r border-border">
      <div className="px-4 pt-5 pb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Threads</h2>
        <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-150 cursor-pointer">
          <Plus className="h-3.5 w-3.5" />
          New task
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-4">
        <Section label="Needs you" count={fixtureThreadSections.needs_you.length}>
          {fixtureThreadSections.needs_you.map((c) => (
            <ChannelLink key={c.id} channel={c} />
          ))}
        </Section>

        <Section label="Active" count={fixtureThreadSections.active.length}>
          {fixtureThreadSections.active.map((c) => (
            <ChannelLink key={c.id} channel={c} />
          ))}
        </Section>

        <Section label="Blocked" count={fixtureThreadSections.blocked.length}>
          {fixtureThreadSections.blocked.map((c) => (
            <ChannelLink key={c.id} channel={c} />
          ))}
        </Section>

        <Section
          label="Direct messages"
          count={fixtureThreadSections.direct_messages.length}
        >
          {fixtureThreadSections.direct_messages.map((dm) => (
            <Link
              key={dm.agent_label}
              href="#"
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-secondary/60 cursor-pointer transition-colors"
            >
              <Avatar
                initial={dm.initial}
                kind={dm.hierarchy}
                size={18}
                presence="running"
              />
              <span className="text-sm truncate flex-1 font-mono text-muted-foreground">
                {dm.agent_label}
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums">{dm.age}</span>
            </Link>
          ))}
        </Section>

        <Section label="Archive" count={fixtureThreadSections.archive_count} />
      </div>
    </aside>
  );
}

function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="px-2 pb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{count}</span>
      </div>
      {children}
    </div>
  );
}

function ChannelLink({ channel }: { channel: ThreadChannel }) {
  const { Icon, color, spin } = STATUS_ICON[channel.status];
  return (
    <Link
      href="#"
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded transition-colors",
        channel.active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/60",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", color, spin && "animate-spin-slow")} />
      <span
        className={cn(
          "text-sm truncate flex-1",
          channel.active && "font-medium text-foreground",
        )}
      >
        {channel.title}
      </span>
      <span className="text-[10px] text-muted-foreground tabular-nums">{channel.age}</span>
    </Link>
  );
}
