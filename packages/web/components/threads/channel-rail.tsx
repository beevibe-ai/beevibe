import { Plus } from "lucide-react";

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
        <Section label="Needs you" count={0} />
        <Section label="Active" count={0} />
        <Section label="Blocked" count={0} />
        <Section label="Direct messages" count={0} />
        <Section label="Archive" count={0} />
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
