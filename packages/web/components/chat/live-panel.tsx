"use client";

import { useEffect, useState } from "react";
import { getLiveStatus, subscribeLiveStatus } from "@/lib/sse";
import { cn } from "@/lib/utils";

const LIVE_STATUS_LABELS = {
  live: {
    dot: "bg-status-running animate-pulse-breathe",
    label: "live · streams via SSE",
    title: undefined as string | undefined,
  },
  "polling-only": {
    dot: "bg-status-review",
    label: "polling every 3s",
    title: "SSE was buffered by the proxy. Updates still arrive every ~3s via polling.",
  },
  connecting: {
    dot: "bg-muted-foreground/60 animate-pulse",
    label: "connecting…",
    title: undefined as string | undefined,
  },
} as const;

/**
 * Tiny SSE/polling status indicator for embedding in the sidebar
 * footer. Tooltip carries the verbose label so the dot stays small.
 */
export function LiveStatusDot({ className }: { className?: string }) {
  const [status, setStatus] = useState(getLiveStatus());
  useEffect(() => subscribeLiveStatus(setStatus), []);
  const { dot, label, title } = LIVE_STATUS_LABELS[status];
  return (
    <span
      className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", dot, className)}
      title={title ?? label}
      aria-label={label}
    />
  );
}
