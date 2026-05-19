"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from "lucide-react";
import { useCollapsible } from "@/lib/hooks/use-collapsible";
import { ConversationSidebar } from "./chat/conversation-sidebar";
import { LiveStatusDot } from "./chat/live-panel";
import { AgentsSidebar, RoomsSidebar, TasksAttentionSidebar } from "./mode-sidebars";
import { ThemeToggle } from "./theme-toggle";
import { UserWidget } from "./user-widget";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
};

// "Teams" tab IS the network canvas — landing on /agents drops you
// into the orbit of your team and the people you collaborate with.
// Metrics / memory / mesh / promotions share this mode's sidebar so
// primary nav stays narrow.
const TEAMS_ROUTES = [
  "/agents",
  "/dashboard",
  "/memory",
  "/mesh",
  "/promotions",
  "/runtimes",
] as const;
const matchesTeams = (p: string): boolean => TEAMS_ROUTES.some((r) => p.startsWith(r));
const matchesChat = (p: string): boolean => p === "/" || p.startsWith("/chat");

const PRIMARY_MODES: NavItem[] = [
  { href: "/agents", label: "Teams", icon: Bot, isActive: matchesTeams },
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
          className="w-full h-full glass-surface hover:bg-secondary/50 flex flex-col items-center pt-3 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-[248px] shrink-0 glass-surface flex flex-col">
      <WorkspaceHeader onCollapse={toggleCollapsed} />

      <ModeStrip pathname={pathname} />

      <div className="mx-2 mt-2 border-t border-border/60" />

      {renderModePanel({
        pathname,
        conversationId,
        isFresh,
        selectedTaskId: searchParams?.get("p") ?? undefined,
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
  return (
    <div className="px-3 py-3 border-t border-border/60">
      <button
        type="button"
        onClick={onClick}
        title="New chat (⌘O)"
        aria-label="New chat (⌘O)"
        className="pearl-button w-full"
      >
        <div className="wrap">
          <p>
            <span>✧</span>
            <span>✦</span>
            New chat
          </p>
        </div>
      </button>
    </div>
  );
}

function WorkspaceHeader({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="flex items-center gap-2 h-12 px-3 mx-2 mt-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt="Beevibe"
        className="h-6 w-6 rounded-md object-cover object-center shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold tracking-tight leading-tight truncate">
          Beevibe
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
  /** Currently-peeked task id from `?p=`, when on /tasks. */
  selectedTaskId: string | undefined;
}

/**
 * Pick the right per-mode sidebar component for the current route.
 * First match wins; falls back to filler space so the chrome height
 * stays consistent across modes that don't have a context list yet.
 */
function renderModePanel(args: ModePanelArgs): React.ReactNode {
  const { pathname, conversationId, isFresh, selectedTaskId } = args;
  if (matchesChat(pathname)) {
    return (
      <ConversationSidebar
        activeConversationId={conversationId}
        isFresh={isFresh}
      />
    );
  }
  if (matchesTeams(pathname)) {
    return <AgentsSidebar pathname={pathname} />;
  }
  if (pathname.startsWith("/rooms")) {
    return <RoomsSidebar activeRoomId={extractIdFromPath(pathname, "/rooms/")} />;
  }
  // /tasks rail surfaces the human-attention inbox: review +
  // blocked + escalation rows. It's NOT a duplicate of the kanban
  // (the old TasksSidebar was). Different axis: kanban = "all work
  // in flight," inbox = "things waiting on you specifically." Clicking
  // a row opens the task detail (or escalation surface) where the
  // human can review and decide — no inline approve.
  if (pathname.startsWith("/tasks")) {
    return (
      <TasksAttentionSidebar
        activeTaskId={selectedTaskId ?? extractIdFromPath(pathname, "/tasks/")}
      />
    );
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
              className="glassy-chip inline-flex items-center gap-1.5 h-8 pl-2.5 pr-3.5 rounded-full text-sm font-medium"
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

