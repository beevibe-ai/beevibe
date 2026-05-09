"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Network,
  Sparkles,
  Terminal,
  TrendingUp,
} from "lucide-react";
import { useAgents } from "@/lib/hooks/use-agents";
import type { AgentDisplay } from "@/lib/types/agents";
import { AgentOnlineDot } from "./agents/agent-online-dot";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { UserWidget } from "./user-widget";

type QuickAction = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
};

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
  badge?: number;
  trailing?: string;
};

// `/` renders the chat surface (the team-agent-first UX); the
// dashboard moved to its own route so the home tile is always
// "talk to your team agent".
const QUICK_ACTIONS: QuickAction[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
];

const WORKSPACE_ITEMS: NavItem[] = [
  {
    href: "/tasks",
    label: "Tasks",
    icon: ListChecks,
    isActive: (p) => p.startsWith("/tasks"),
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

const SETTINGS_ITEMS: NavItem[] = [
  {
    href: "/runtimes",
    label: "Runtimes",
    icon: HardDrive,
    isActive: (p) => p.startsWith("/runtimes"),
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [openAgents, setOpenAgents] = useState(true);
  const [openWorkspace, setOpenWorkspace] = useState(true);
  const [openKnowledge, setOpenKnowledge] = useState(true);
  const [openSettings, setOpenSettings] = useState(true);

  return (
    <aside className="w-[248px] shrink-0 bg-card border-r border-border/60 flex flex-col">
      <WorkspaceHeader />

      <div className="px-2 pt-1 pb-2 space-y-px">
        {QUICK_ACTIONS.map((a) => (
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
        ))}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-3" aria-label="Main">
        <Section
          title="Agents"
          open={openAgents}
          onToggle={() => setOpenAgents((v) => !v)}
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

        <Section
          title="Settings"
          open={openSettings}
          onToggle={() => setOpenSettings((v) => !v)}
        >
          {SETTINGS_ITEMS.map((item) => (
            <NavRow key={item.href} item={item} pathname={pathname} />
          ))}
        </Section>
      </nav>

      <div className="p-2 border-t border-border/60 flex items-center gap-1">
        <UserWidget />
        <ThemeToggle />
      </div>
    </aside>
  );
}

function WorkspaceHeader() {
  return (
    <div className="h-12 px-3 mx-2 mt-2 flex items-center gap-2">
      <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center shrink-0">
        <span className="text-primary-foreground text-[13px] font-bold leading-none">b</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold tracking-tight leading-tight truncate">
          beevibe
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
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

function AgentList({ pathname }: { pathname: string }) {
  const { data, isLoading } = useAgents();
  if (isLoading) {
    return (
      <div className="space-y-px">
        {[0, 1].map((i) => (
          <div key={i} className="h-7 pl-5 pr-2 flex items-center">
            <div className="h-3 w-24 rounded bg-muted animate-pulse" />
          </div>
        ))}
      </div>
    );
  }
  const agents = data ?? [];
  if (agents.length === 0) {
    return (
      <div className="h-7 pl-5 pr-2 flex items-center text-sm text-muted-foreground/60">
        No agents yet
      </div>
    );
  }
  return (
    <div className="space-y-px">
      {agents.map((a) => (
        <AgentRow key={a.id} agent={a} pathname={pathname} />
      ))}
    </div>
  );
}

function AgentRow({ agent, pathname }: { agent: AgentDisplay; pathname: string }) {
  const href = `/agents/${agent.id}`;
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 h-7 pl-5 pr-2 rounded-md text-sm transition-colors",
        active
          ? "bg-secondary text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/70",
      )}
    >
      <AgentOnlineDot preferredRuntimeId={agent.preferred_runtime_id} />
      <span className="flex-1 truncate">{agent.display_name}</span>
      <span
        className={cn(
          "shrink-0 px-1 py-px rounded text-[9px] font-mono uppercase tracking-wide",
          agent.hierarchy === "team" && "bg-hier-team/15 text-hier-team",
          agent.hierarchy === "org" && "bg-hier-org/15 text-hier-org",
          agent.hierarchy === "ic" && "bg-muted/70 text-muted-foreground",
        )}
      >
        {agent.hierarchy}
      </span>
    </Link>
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
