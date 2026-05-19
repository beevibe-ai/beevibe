"use client";

import { useEffect } from "react";

export default function GlobalError({
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
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            color: "#111",
            background: "#fbf9f5",
          }}
        >
          <section style={{ maxWidth: 420, textAlign: "center" }}>
            <div
              style={{
                marginBottom: 8,
                fontFamily: "ui-monospace, Menlo, monospace",
                fontSize: 12,
                color: "#71717a",
              }}
            >
              Fatal render error
            </div>
            <h1 style={{ margin: "0 0 8px", fontSize: 28, lineHeight: 1.15 }}>
              Beevibe needs a refresh
            </h1>
            <p style={{ margin: "0 0 24px", fontSize: 14, lineHeight: 1.6, color: "#71717a" }}>
              The root app shell failed while rendering. Try again once; if it
              repeats, the browser console will show the underlying exception.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                height: 36,
                border: 0,
                borderRadius: 6,
                padding: "0 12px",
                fontWeight: 600,
                cursor: "pointer",
                background: "#facc15",
                color: "#111",
              }}
            >
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
