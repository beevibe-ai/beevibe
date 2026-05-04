"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  Terminal,
  TrendingUp,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAgents } from "@/lib/hooks/use-agents";
import { useCollapsible } from "@/lib/hooks/use-collapsible";
import { ConversationSidebar } from "./chat/conversation-sidebar";
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

const QUICK_ACTIONS: QuickAction[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/rooms", label: "Rooms", icon: Users },
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

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [openAgents, setOpenAgents] = useState(true);
  const [openWorkspace, setOpenWorkspace] = useState(true);
  const [openKnowledge, setOpenKnowledge] = useState(true);
  // /chat (and /, which renders ChatClient too) is a chat surface;
  // when there, the sidebar swaps its sections for the conversation
  // list — Notion-style one-rail morphing instead of stacking three.
  const isChatRoute = pathname === "/" || (pathname?.startsWith("/chat") ?? false);
  const [collapsed, toggleCollapsed] = useCollapsible("bv-sidebar-collapsed");

  const conversationId = searchParams?.get("c") ?? undefined;
  const isFresh = searchParams?.get("new") === "1";
  const startNewConversation = useCallback(() => {
    router.push("/chat?new=1");
  }, [router]);

  // Keyboard shortcut: Cmd-\ (Mac) / Ctrl-\ (others) toggles the
  // sidebar. Without this, a fresh user on /chat sees a 36px rail
  // they might not realize is interactive — the shortcut + a tooltip
  // hint give two paths to discover it. Backslash chosen because
  // it's unbound globally and doesn't collide with browser/editor
  // defaults the way Cmd-B (bold) or Cmd-/ (search) do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapsed]);

  if (collapsed) {
    // The whole rail is the click target — no need to aim at the
    // icon. Tooltip carries the shortcut so power users learn it.
    return (
      <aside aria-label="Sidebar (collapsed)" className="w-9 shrink-0">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand sidebar (⌘\\)"
          title="Expand sidebar (⌘\\)"
          className="w-full h-full bg-card border-r border-border/60 hover:bg-secondary/50 flex flex-col items-center pt-3 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-[248px] shrink-0 bg-card border-r border-border/60 flex flex-col">
      <WorkspaceHeader onCollapse={toggleCollapsed} />

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

      {isChatRoute ? (
        <ConversationSidebar
          activeConversationId={conversationId}
          isFresh={isFresh}
          onNew={startNewConversation}
        />
      ) : (
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
        </nav>
      )}

      <div className="p-2 border-t border-border/60 flex items-center gap-1">
        <UserWidget />
        <ThemeToggle />
      </div>
    </aside>
  );
}

function WorkspaceHeader({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="flex items-center gap-2 h-12 px-3 mx-2 mt-2">
      <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center shrink-0">
        <span className="text-primary-foreground text-[13px] font-bold leading-none">b</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold tracking-tight leading-tight truncate">
          beevibe
        </div>
      </div>
      <button
        type="button"
        onClick={onCollapse}
        aria-label="Collapse sidebar (⌘\)"
        title="Collapse sidebar (⌘\)"
        className="h-6 w-6 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors shrink-0"
      >
        <PanelLeftClose className="h-3.5 w-3.5" />
      </button>
    </div>
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

function AgentList({ pathname }: { pathname: string }) {
  const { data, isLoading } = useAgents();
  if (isLoading) {
    return (
      <div className="h-7 pl-5 pr-2 flex items-center text-sm text-muted-foreground/60">
        Loading…
      </div>
    );
  }
  const agents = data ?? [];
  if (agents.length === 0) {
    return (
      <div className="px-5 py-1 text-xs text-muted-foreground/70 leading-relaxed">
        No agents yet — your team agent will spawn specialists when you point it at a codebase.
      </div>
    );
  }
  // Team agents first (sort already does that — by hierarchy weight); then
  // their IC subordinates indented one level. We don't render an explicit
  // "all" footer link because clicking a name itself navigates to /agents/[id]
  // and the section header already has nav-by-route on the icon.
  return (
    <ul>
      {agents.map((a) => {
        const active = pathname === `/agents/${a.id}`;
        const indent = a.hierarchy === "ic" ? "pl-9" : "pl-5";
        return (
          <li key={a.id}>
            <Link
              href={`/agents/${a.id}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 h-7 pr-2 rounded-md text-sm transition-colors",
                indent,
                active
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/70",
              )}
            >
              <Bot className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate">{a.name}</span>
              <span
                className={cn(
                  "shrink-0 px-1 py-px rounded text-[9px] font-mono uppercase tracking-wide",
                  a.hierarchy === "team" && "bg-hier-team/15 text-hier-team",
                  a.hierarchy === "org" && "bg-hier-org/15 text-hier-org",
                  a.hierarchy === "ic" && "bg-muted text-muted-foreground",
                )}
              >
                {a.hierarchy}
              </span>
            </Link>
          </li>
        );
      })}
      <li>
        <Link
          href="/agents"
          className="flex items-center h-7 pl-5 pr-2 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors"
        >
          View all →
        </Link>
      </li>
    </ul>
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
