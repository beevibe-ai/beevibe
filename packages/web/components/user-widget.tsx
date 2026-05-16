"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, LogOut } from "lucide-react";
import { useMe } from "@/lib/hooks/use-me";
import { clearUserKey } from "@/lib/api/config";
import { cn } from "@/lib/utils";

export function UserWidget() {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const name = me?.person.name ?? "Signed in";
  const initial = name.charAt(0).toUpperCase() || "?";

  const signOut = () => {
    clearUserKey();
    setOpen(false);
    router.replace("/sign-in");
  };

  return (
    <div ref={ref} className="flex-1 min-w-0 relative">
      <button
        type="button"
        aria-label={`User menu — ${name}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-secondary cursor-pointer transition-colors text-left"
      >
        <div className="h-7 w-7 rounded-full bg-secondary border border-border flex items-center justify-center text-xs font-medium shrink-0">
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate leading-tight">{name}</div>
          <div className="text-[10px] text-muted-foreground truncate leading-tight mt-0.5">
            {me?.person.email ?? "—"}
          </div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute bottom-full left-0 right-0 mb-2 z-50 rounded-md border border-border bg-popover shadow-lg py-1",
          )}
        >
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-secondary cursor-pointer text-left"
          >
            <LogOut className="h-3.5 w-3.5 text-muted-foreground" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
