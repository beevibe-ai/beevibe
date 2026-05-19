"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Brain,
  ChevronsUpDown,
  LogOut,
  Settings,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react";
import { useMe } from "@/lib/hooks/use-me";
import { clearUserKey } from "@/lib/api/config";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/avatar";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type View = "closed" | "menu" | "invite";

export function UserWidget() {
  const { data: me } = useMe();
  const [view, setView] = useState<View>("closed");
  const router = useRouter();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (view === "closed") return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setView("closed");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView("closed");
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [view]);

  const name = me?.person.name ?? "Signed in";
  const initial = name.charAt(0).toUpperCase() || "?";

  const signOut = () => {
    clearUserKey();
    setView("closed");
    router.replace("/sign-in");
  };

  const close = () => setView("closed");
  const open = view !== "closed";

  return (
    <div ref={ref} className="flex-1 min-w-0 relative">
      <button
        type="button"
        aria-label={`User menu — ${name}`}
        aria-expanded={open}
        onClick={() => setView((v) => (v === "closed" ? "menu" : "closed"))}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-secondary cursor-pointer transition-colors text-left"
      >
        <Avatar
          initial={initial}
          kind="person"
          label={name}
          specialization={me?.person.email ?? undefined}
          size={28}
          className="shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate leading-tight">{name}</div>
          <div className="text-[10px] text-muted-foreground truncate leading-tight mt-0.5">
            {me?.person.email ?? "—"}
          </div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </button>
      {view === "menu" ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-2 z-50 w-[220px] rounded-md glass-surface shadow-xl py-1"
        >
          <MenuItem icon={Brain} label="My memory" href="/memory" onActivate={close} />
          <MenuItem
            icon={UserRoundPlus}
            label="Invite teammate"
            onActivate={() => setView("invite")}
          />
          <div className="my-1 border-t border-border" />
          <MenuItem icon={Settings} label="Runtimes" href="/runtimes" onActivate={close} />
          <MenuItem icon={LogOut} label="Sign out" tone="destructive" onActivate={signOut} />
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={BookOpen}
            label="Docs"
            href="https://beevibe.ai"
            external
            onActivate={close}
          />
        </div>
      ) : null}
      {view === "invite" ? <InviteTeammateDialog onClose={close} /> : null}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  href,
  external,
  tone = "default",
  onActivate,
}: {
  icon: LucideIcon;
  label: string;
  href?: string;
  external?: boolean;
  tone?: "default" | "destructive";
  onActivate: () => void;
}) {
  const cls = cn(
    "w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[13px] cursor-pointer transition-colors",
    tone === "destructive"
      ? "text-foreground hover:bg-destructive/10 hover:text-destructive"
      : "text-foreground hover:bg-secondary",
  );
  const inner: ReactNode = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="flex-1 truncate">{label}</span>
    </>
  );
  if (href && external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" onClick={onActivate} role="menuitem" className={cls}>
        {inner}
      </a>
    );
  }
  if (href) {
    return (
      <Link href={href} onClick={onActivate} role="menuitem" className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" role="menuitem" onClick={onActivate} className={cls}>
      {inner}
    </button>
  );
}

function InviteTeammateDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);
  const trimmed = email.trim().toLowerCase();
  const valid = EMAIL_RE.test(trimmed);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const shareLink = valid
    ? `${origin}/sign-up?email=${encodeURIComponent(trimmed)}`
    : "";

  const copyLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; the input is
      // still selectable for manual copy.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-card border border-border rounded-lg p-5 w-full max-w-md shadow-md"
      >
        <h3 className="text-sm font-semibold mb-1">Invite a teammate</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Share a sign-up link. When they sign up, they get their own team
          agent — then you can pull them into rooms with you.
        </p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          placeholder="alice@example.com"
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {shareLink ? (
          <div className="mt-3 rounded border border-border bg-muted/40 p-3">
            <div className="text-[11px] text-muted-foreground mb-1.5">
              Send them this link:
            </div>
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={shareLink}
                className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-[11px] font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                onClick={copyLink}
                className="h-7 px-2.5 rounded text-[11px] font-medium border border-border hover:bg-secondary transition-colors cursor-pointer shrink-0"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
