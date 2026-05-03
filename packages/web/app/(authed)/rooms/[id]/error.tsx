"use client";

/**
 * Next.js per-route error boundary. Renders when any React component
 * inside `/rooms/[id]` throws — instead of falling back to the global
 * not-found page (which says "nothing shows up"), the user sees the
 * actual error + a reset button.
 *
 * Demo blocker we hit: a stale-cache RoomDetail with `data.typing`
 * undefined would crash on `.length`, taking the whole route down
 * silently. With this boundary the user immediately sees what
 * happened and we can fix the underlying read-side defensiveness.
 */

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function RoomError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[room route]", error);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-status-failed/40 bg-status-failed/5 p-5">
        <div className="flex items-center gap-2 text-status-failed font-medium mb-2">
          <AlertTriangle className="h-4 w-4" />
          The room view crashed
        </div>
        <pre className="whitespace-pre-wrap break-all text-xs text-foreground/80 bg-card border border-border rounded p-2 mb-3 max-h-64 overflow-auto">
          {error.message}
          {error.stack ? `\n\n${error.stack.split("\n").slice(0, 8).join("\n")}` : ""}
        </pre>
        <p className="text-xs text-muted-foreground mb-3">
          A hard reload (Cmd/Ctrl + Shift + R) usually clears stale-bundle issues. If that
          doesn&apos;t help, the message above plus the api log will narrow the cause.
        </p>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer"
        >
          <RotateCcw className="h-3 w-3" />
          Try again
        </button>
      </div>
    </div>
  );
}
