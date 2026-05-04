"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCollapsible } from "@/lib/hooks/use-collapsible";
import { ConversationSidebar } from "./chat/conversation-sidebar";
import { ThemeToggle } from "./theme-toggle";
import { UserWidget } from "./user-widget";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
  badge?: number;
};

// Single flat nav list — every top-level surface in one place. The
// previous Quick Actions / Workspace / Knowledge split was redundant
// chrome (3 collapsible sections for 7 items, each section's heading
// taking real estate the items themselves needed). Notion does the
// same: one list of mode-switches at the top, content below.
const NAV_ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Chat",
    icon: MessageSquare,
    isActive: (p) => p === "/" || p.startsWith("/chat"),
  },
  {
    href: "/rooms",
    label: "Rooms",
    icon: Users,
    isActive: (p) => p.startsWith("/rooms"),
  },
  {
    href: "/tasks",
    label: "Tasks",
    icon: ListChecks,
    isActive: (p) => p.startsWith("/tasks"),
  },
  {
    href: "/agents",
    label: "Agents",
    icon: Bot,
    isActive: (p) => p.startsWith("/agents"),
  },
  {
    href: "/memory",
    label: "Memory",
    icon: Sparkles,
    isActive: (p) => p.startsWith("/memory"),
  },
  {
    href: "/mesh",
    label: "Mesh",
    icon: Network,
    isActive: (p) => p.startsWith("/mesh"),
  },
  {
    href: "/promotions",
    label: "Promotions",
    icon: TrendingUp,
    isActive: (p) => p.startsWith("/promotions"),
  },
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    isActive: (p) => p.startsWith("/dashboard"),
  },
];

export function Sidebar() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  // /chat (and /, which renders ChatClient too) is a chat surface;
  // when there, the sidebar swaps its sections for the conversation
  // list — Notion-style one-rail morphing instead of stacking three.
  const isChatRoute = pathname === "/" || pathname.startsWith("/chat");
  const [collapsed, toggleCollapsed] = useCollapsible("bv-sidebar-collapsed");

  const conversationId = searchParams?.get("c") ?? undefined;
  const isFresh = searchParams?.get("new") === "1";
  const startNewConversation = useCallback(() => {
    router.push("/chat?new=1");
  }, [router]);

  // Keyboard shortcut: ⌘\ (Mac) / Ctrl-\ (others) toggles the sidebar
  // from anywhere. Backslash is unbound globally and doesn't collide
  // with browser/editor defaults the way Cmd-B or Cmd-/ would.
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
          aria-label="Expand sidebar (⌘\)"
          title="Expand sidebar (⌘\)"
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

      <nav className="px-2 pt-1 pb-2 space-y-px" aria-label="Main">
        {NAV_ITEMS.map((item) => (
          <NavRow key={item.href} item={item} pathname={pathname} />
        ))}
      </nav>

      {isChatRoute ? (
        <>
          <div className="mx-2 my-1 border-t border-border/60" />
          <ConversationSidebar
            activeConversationId={conversationId}
            isFresh={isFresh}
            onNew={startNewConversation}
          />
        </>
      ) : (
        // Other routes are themselves the list-of-X view (page IS the
        // list); the sidebar's job is just navigation, not a second
        // copy of the data. Empty space is fine here.
        <div className="flex-1" />
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

function NavRow({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = item.isActive(pathname);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 h-7 px-2 rounded-md text-sm transition-colors",
        active
          ? "bg-secondary text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/70",
      )}
    >
      <item.icon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge ? <Badge value={item.badge} /> : null}
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
