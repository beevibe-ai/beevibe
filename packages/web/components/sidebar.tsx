"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Home,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAgents } from "@/lib/hooks/use-agents";
import { useCollapsible } from "@/lib/hooks/use-collapsible";
import { useInbox } from "@/lib/hooks/use-inbox";
import { Avatar } from "./avatar";
import { ConversationSidebar } from "./chat/conversation-sidebar";
import { LiveStatusDot } from "./chat/live-panel";
import { HomeSidebar, RoomsSidebar, TasksSidebar } from "./mode-sidebars";
import { ThemeToggle } from "./theme-toggle";
import { UserWidget } from "./user-widget";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
};

// Home is the launchpad: inbox + your team + observability views all
// live there. Routes that map under it: /dashboard, /agents, /memory,
// /mesh, /promotions. Chat / Rooms / Tasks remain their own modes
// because they're full surfaces, not launchpad widgets.
const HOME_ROUTES = ["/dashboard", "/agents", "/memory", "/mesh", "/promotions"] as const;
const matchesHome = (p: string): boolean => HOME_ROUTES.some((r) => p.startsWith(r));
const matchesChat = (p: string): boolean => p === "/" || p.startsWith("/chat");

const PRIMARY_MODES: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: Home, isActive: matchesHome },
  { href: "/", label: "Chat", icon: MessageSquare, isActive: matchesChat },
  { href: "/rooms", label: "Rooms", icon: Users, isActive: (p) => p.startsWith("/rooms") },
  { href: "/tasks", label: "Tasks", icon: ListChecks, isActive: (p) => p.startsWith("/tasks") },
];

export function Sidebar() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const [collapsed, toggleCollapsed] = useCollapsible("bv-sidebar-collapsed");

  const conversationId = searchParams?.get("c") ?? undefined;
  const isFresh = searchParams?.get("new") === "1";
  const startNewConversation = useCallback(() => {
    router.push("/chat?new=1");
  }, [router]);

  // Global keyboard shortcuts:
  //   ⌘\  toggles sidebar (unbound elsewhere; doesn't collide)
  //   ⌘O  starts a new chat (matches Notion's "+ New chat ⌘O")
  // Both bypass when the user is already typing — text fields and
  // contenteditable surfaces own those keystrokes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      const inEditable =
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "\\") {
        e.preventDefault();
        toggleCollapsed();
        return;
      }
      if ((e.key === "o" || e.key === "O") && !inEditable) {
        e.preventDefault();
        startNewConversation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapsed, startNewConversation]);

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

      <div className="mx-2 mt-2 border-t border-border/60" />

      {renderModePanel({
        pathname,
        conversationId,
        isFresh,
      })}

      <NewChatButton onClick={startNewConversation} />

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

function NewChatButton({ onClick }: { onClick: () => void }) {
  // Pinned-bottom global affordance — always one click (or ⌘O) away
  // regardless of mode. Same role as Notion's "+ New chat ⌘O" pill.
  // Uses the team-agent avatar leading icon so the button reads as
  // "talk to your team", not a generic "create".
  const agents = useAgents();
  const teamAgent = agents.data?.find((a) => a.hierarchy !== "ic");
  const initial = (teamAgent?.display_name ?? teamAgent?.name ?? "?").charAt(0).toUpperCase();
  return (
    <div className="px-2 py-2 border-t border-border/60">
      <button
        type="button"
        onClick={onClick}
        title="New chat (⌘O)"
        aria-label="New chat (⌘O)"
        className="w-full inline-flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full bg-secondary/70 hover:bg-secondary text-foreground text-sm font-medium transition-colors cursor-pointer"
      >
        <Avatar
          initial={initial}
          kind={teamAgent?.hierarchy ?? "team"}
          size={24}
        />
        <span className="flex-1 text-left">New chat</span>
        <kbd className="text-[10px] font-mono text-muted-foreground/80 tabular-nums">
          ⌘O
        </kbd>
      </button>
    </div>
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
 * Extract the `:id` segment after a known prefix so the per-mode
 * sidebar can highlight the active item. Returns `undefined` when the
 * path is just the index (e.g. `/agents`, no id) or doesn't match.
 */
function extractIdFromPath(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (!rest) return undefined;
  const id = rest.split("/")[0];
  return id || undefined;
}

interface ModePanelArgs {
  pathname: string;
  conversationId: string | undefined;
  isFresh: boolean;
}

/**
 * Pick the right per-mode sidebar component for the current route.
 * First match wins; falls back to filler space so the chrome height
 * stays consistent across modes that don't have a context list yet.
 */
function renderModePanel(args: ModePanelArgs): React.ReactNode {
  const { pathname, conversationId, isFresh } = args;
  if (matchesChat(pathname)) {
    return (
      <ConversationSidebar
        activeConversationId={conversationId}
        isFresh={isFresh}
      />
    );
  }
  if (matchesHome(pathname)) {
    return (
      <HomeSidebar
        pathname={pathname}
        activeAgentId={extractIdFromPath(pathname, "/agents/")}
      />
    );
  }
  if (pathname.startsWith("/rooms")) {
    return <RoomsSidebar activeRoomId={extractIdFromPath(pathname, "/rooms/")} />;
  }
  if (pathname.startsWith("/tasks")) {
    return <TasksSidebar activeTaskId={extractIdFromPath(pathname, "/tasks/")} />;
  }
  return <div className="flex-1" />;
}

/**
 * Horizontal icon strip for primary modes. Active mode expands to a
 * pill with its label inline; inactive modes stay icon-only with a
 * hover tooltip. Models Notion's Home / Chat / Mic / Inbox / Search
 * strip — visual gesture for mode-switching, no vertical bloat.
 */
function ModeStrip({ pathname }: { pathname: string }) {
  // Home gets a count badge for inbox items so the human knows at a
  // glance whether they owe a decision somewhere — same affordance
  // as "5 unread" on a mail icon. Only shown when there's actually
  // something pending so an empty inbox stays visually quiet.
  const inbox = useInbox();
  const inboxCount = inbox.data?.length ?? 0;

  return (
    <nav
      aria-label="Primary modes"
      className="flex items-center gap-0.5 px-2 pt-1 pb-1.5"
    >
      {PRIMARY_MODES.map((item) => {
        const active = item.isActive(pathname);
        const badge = item.href === "/dashboard" && inboxCount > 0 ? inboxCount : undefined;
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
              {badge !== undefined ? <ModeBadge count={badge} /> : null}
            </Link>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={badge !== undefined ? `${item.label} (${badge})` : item.label}
            title={item.label}
            className="relative h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          >
            <item.icon className="h-4 w-4" />
            {badge !== undefined ? (
              <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-status-review" />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function ModeBadge({ count }: { count: number }) {
  return (
    <span className="ml-0.5 inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded text-[10px] font-medium bg-status-review/15 text-status-review tabular-nums">
      {count}
    </span>
  );
}

