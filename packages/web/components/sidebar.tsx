"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Home,
  Inbox,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Network,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Terminal,
  TrendingUp,
} from "lucide-react";
import { fixtureAgents, fixtureFleetCounts } from "@/lib/fixtures/agents";
import { fixtureCounts } from "@/lib/fixtures/tasks";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { UserWidget } from "./user-widget";

type QuickAction = {
  href?: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  onClick?: () => void;
};

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
  badge?: number;
  trailing?: string;
};

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Search", icon: Search, onClick: () => {} },
  { href: "/", label: "Home", icon: Home },
  { href: "/threads", label: "Inbox", icon: Inbox, badge: fixtureCounts.mineToReview },
];

const WORKSPACE_ITEMS: NavItem[] = [
  {
    href: "/tasks",
    label: "Tasks",
    icon: ListChecks,
    isActive: (p) => p.startsWith("/tasks"),
    trailing: String(fixtureCounts.active),
  },
  {
    href: "/threads",
    label: "Threads",
    icon: MessageSquare,
    isActive: (p) => p.startsWith("/threads"),
  },
  {
    href: "/mesh",
    label: "Mesh",
    icon: Network,
    isActive: (p) => p.startsWith("/mesh"),
  },
];

const KNOWLEDGE_ITEMS: NavItem[] = [
  {
    href: "/memory",
    label: "Memory",
    icon: Sparkles,
    isActive: (p) => p.startsWith("/memory"),
  },
  {
    href: "/promotions",
    label: "Promotions",
    icon: TrendingUp,
    isActive: (p) => p.startsWith("/promotions"),
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [openAgents, setOpenAgents] = useState(true);
  const [openWorkspace, setOpenWorkspace] = useState(true);
  const [openKnowledge, setOpenKnowledge] = useState(true);

  return (
    <aside className="w-[248px] shrink-0 bg-card border-r border-border/60 flex flex-col">
      <WorkspaceSwitcher />

      <div className="px-2 pt-1 pb-2 space-y-px">
        {QUICK_ACTIONS.map((a) =>
          a.href ? (
            <Link
              key={a.label}
              href={a.href}
              aria-current={pathname === a.href ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 h-7 px-2 rounded-md text-sm transition-colors",
                pathname === a.href
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/70",
              )}
            >
              <a.icon className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate">{a.label}</span>
              {a.badge ? <Badge value={a.badge} /> : null}
            </Link>
          ) : (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              className="w-full flex items-center gap-2.5 h-7 px-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors cursor-pointer"
            >
              <a.icon className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate text-left">{a.label}</span>
              <kbd className="text-[10px] font-mono text-muted-foreground/70 bg-secondary/60 px-1 rounded border border-border">
                ⌘K
              </kbd>
            </button>
          ),
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-3" aria-label="Main">
        <Section
          title="Agents"
          count={fixtureFleetCounts.total}
          open={openAgents}
          onToggle={() => setOpenAgents((v) => !v)}
          actionLabel="New agent"
          onAction={() => {}}
        >
          <AgentList pathname={pathname} />
        </Section>

        <Section
          title="Workspace"
          open={openWorkspace}
          onToggle={() => setOpenWorkspace((v) => !v)}
        >
          {WORKSPACE_ITEMS.map((item) => (
            <div key={item.href}>
              <NavRow item={item} pathname={pathname} />
              {item.href === "/tasks" ? <ActiveSessionPin pathname={pathname} /> : null}
            </div>
          ))}
        </Section>

        <Section
          title="Knowledge"
          open={openKnowledge}
          onToggle={() => setOpenKnowledge((v) => !v)}
        >
          {KNOWLEDGE_ITEMS.map((item) => (
            <NavRow key={item.href} item={item} pathname={pathname} />
          ))}
        </Section>
      </nav>

      <div className="p-2 border-t border-border/60 flex items-center gap-1">
        <UserWidget />
        <ThemeToggle />
        <button
          type="button"
          aria-label="Sidebar settings"
          className="h-8 w-8 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors shrink-0"
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}

function WorkspaceSwitcher() {
  return (
    <button
      type="button"
      aria-label="Switch owner"
      className="group flex items-center gap-2 h-12 px-3 mx-2 mt-2 rounded-md hover:bg-secondary/70 cursor-pointer transition-colors"
    >
      <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center shrink-0">
        <span className="text-primary-foreground text-[13px] font-bold leading-none">b</span>
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="text-sm font-semibold tracking-tight leading-tight truncate">
          Weijia&apos;s beevibe
        </div>
        <div className="text-[10px] text-muted-foreground leading-tight mt-0.5 truncate">
          1 owner · 7 agents
        </div>
      </div>
      <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
    </button>
  );
}

function Section({
  title,
  count,
  open,
  onToggle,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  actionLabel?: string;
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-px">
      <div className="group flex items-center h-6 px-2 -mx-px">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex items-center gap-1 flex-1 min-w-0 cursor-pointer"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          )}
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70 group-hover:text-muted-foreground transition-colors">
            {title}
          </span>
          {count !== undefined ? (
            <span className="text-[10px] text-muted-foreground/50 ml-1 tabular-nums">
              {count}
            </span>
          ) : null}
        </button>
        {actionLabel ? (
          <button
            type="button"
            onClick={onAction}
            aria-label={actionLabel}
            title={actionLabel}
            className="opacity-0 group-hover:opacity-100 h-5 w-5 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-all"
          >
            <Plus className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      {open ? <div className="space-y-px">{children}</div> : null}
    </div>
  );
}

function NavRow({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = item.isActive(pathname);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 h-7 pl-5 pr-2 rounded-md text-sm transition-colors",
        active
          ? "bg-secondary text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/70",
      )}
    >
      <item.icon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge ? <Badge value={item.badge} /> : null}
      {item.trailing ? (
        <span className="text-[10px] text-muted-foreground/60 tabular-nums">{item.trailing}</span>
      ) : null}
    </Link>
  );
}

const HIER_DOT: Record<"org" | "team" | "ic", string> = {
  org: "bg-hier-org",
  team: "bg-hier-team",
  ic: "bg-hier-ic",
};

const RUNNING_AGENT_IDS = new Set(["agt_ic1", "agt_ic3"]);

function AgentList({ pathname }: { pathname: string }) {
  return (
    <>
      {fixtureAgents.map((agent) => {
        const href = `/agents/${agent.id}`;
        const active = pathname === href;
        const running = RUNNING_AGENT_IDS.has(agent.id);
        return (
          <Link
            key={agent.id}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-2 h-7 pl-5 pr-2 rounded-md text-sm transition-colors",
              active
                ? "bg-secondary text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/70",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full shrink-0",
                HIER_DOT[agent.hierarchy],
              )}
              aria-hidden
            />
            <span className="flex-1 truncate font-mono text-[12px]">
              {agent.display_name}
            </span>
            {running ? (
              <span
                className="h-1.5 w-1.5 rounded-full bg-status-running animate-pulse-breathe shrink-0"
                aria-label="running"
              />
            ) : null}
          </Link>
        );
      })}
      <button
        type="button"
        className="flex items-center gap-2 h-7 pl-5 pr-2 rounded-md text-sm text-muted-foreground/70 hover:text-foreground hover:bg-secondary/70 cursor-pointer transition-colors w-full"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">New agent</span>
      </button>
    </>
  );
}

function ActiveSessionPin({ pathname }: { pathname: string }) {
  const match = pathname.match(/^\/tasks\/([^/]+)\/sessions\/([^/]+)/);
  if (!match) return null;
  const [, taskId, sid] = match;
  return (
    <Link
      href={`/tasks/${taskId}/sessions/${sid}`}
      aria-current="page"
      className="flex items-center gap-2 h-7 pl-9 pr-2 rounded-md text-sm bg-secondary text-foreground font-medium"
    >
      <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-[12px] truncate">{sid}</span>
    </Link>
  );
}

function Badge({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded text-[10px] font-medium bg-status-review/15 text-status-review tabular-nums">
      {value}
    </span>
  );
}
