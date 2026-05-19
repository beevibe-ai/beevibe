"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className="font-mono text-xs text-muted-foreground mb-2">
          Something slipped
        </div>
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          Beevibe hit an error
        </h1>
        <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
          The page failed while rendering. Try again once; if it repeats, the
          console output will have the useful detail.
        </p>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center h-9 px-3 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 active:scale-[0.98] transition-all duration-150"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
