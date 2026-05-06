"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  Home,
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
import { LiveStatusDot } from "./chat/live-panel";
import { ThemeToggle } from "./theme-toggle";
import { UserWidget } from "./user-widget";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
};

// Notion-style mode strip: a horizontal row of small icons at the top
// of the sidebar. The active mode expands to a pill with its label;
// inactive modes are icon-only with a tooltip. Saves vertical real
// estate, makes mode-switching feel like a single visual gesture
// instead of scanning a long list.
const PRIMARY_MODES: NavItem[] = [
  {
    href: "/dashboard",
    label: "Home",
    icon: Home,
    isActive: (p) => p.startsWith("/dashboard"),
  },
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
];

// Secondary surfaces — observability/audit views power users navigate
// to occasionally, not the main daily modes. Same place as Notion's
// Library / Help / Trash bottom-pinned utility links.
const UTILITY: NavItem[] = [
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
];

export function Sidebar() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const isChatRoute = pathname === "/" || pathname.startsWith("/chat");
  const [collapsed, toggleCollapsed] = useCollapsible("bv-sidebar-collapsed");

  const conversationId = searchParams?.get("c") ?? undefined;
  const isFresh = searchParams?.get("new") === "1";
  const startNewConversation = useCallback(() => {
    router.push("/chat?new=1");
  }, [router]);

  // ⌘\ (Mac) / Ctrl-\ (others) toggles from anywhere — unbound
  // globally, doesn't collide with browser/editor defaults.
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

      <ModeStrip pathname={pathname} />

      {isChatRoute ? (
        <>
          <div className="mx-2 mt-2 border-t border-border/60" />
          <ConversationSidebar
            activeConversationId={conversationId}
            isFresh={isFresh}
            onNew={startNewConversation}
          />
        </>
      ) : (
        // Other routes are themselves list-of-X views; the page IS the
        // list. Empty space sits between the mode strip and the
        // utility footer — same pattern Notion uses on non-chat modes.
        <div className="flex-1" />
      )}

      <UtilityNav pathname={pathname} />

      <div className="p-2 border-t border-border/60 flex items-center gap-1">
        <UserWidget />
        {/* Always-visible live/polling indicator — LivePanel defaults
            collapsed, so without this the user couldn't tell whether
            updates were streaming or polling unless they expanded it. */}
        <LiveStatusDot className="mx-1" />
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

/**
 * Horizontal icon strip for primary modes. Active mode expands to a
 * pill with its label inline; inactive modes stay icon-only with a
 * hover tooltip. Models Notion's Home / Chat / Mic / Inbox / Search
 * strip — visual gesture for mode-switching, no vertical bloat.
 */
function ModeStrip({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Primary modes"
      className="flex items-center gap-0.5 px-2 pt-1 pb-1.5"
    >
      {PRIMARY_MODES.map((item) => {
        const active = item.isActive(pathname);
        if (active) {
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current="page"
              className="inline-flex items-center gap-1.5 h-8 pl-2 pr-3 rounded-full bg-secondary text-foreground text-sm font-medium transition-colors"
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="leading-none">{item.label}</span>
            </Link>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            title={item.label}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          >
            <item.icon className="h-4 w-4" />
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Bottom-pinned utility links — secondary surfaces (Memory / Mesh /
 * Promotions) that don't rate the primary mode strip. Small text,
 * dim by default, active row gets the same pill emphasis pattern as
 * the rest of the app for consistency.
 */
function UtilityNav({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Utility"
      className="px-2 py-1.5 border-t border-border/60 space-y-px"
    >
      {UTILITY.map((item) => {
        const active = item.isActive(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 h-6 px-2 rounded-md text-[12px] transition-colors",
              active
                ? "bg-secondary text-foreground font-medium"
                : "text-muted-foreground/80 hover:text-foreground hover:bg-secondary/60",
            )}
          >
            <item.icon className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
