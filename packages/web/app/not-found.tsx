import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className="font-mono text-xs text-muted-foreground mb-2">404</div>
        <h1 className="text-2xl font-semibold tracking-tight mb-2">Page not found</h1>
        <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
          The route you followed doesn&rsquo;t resolve to anything in this workspace. It may have been
          renamed, archived, or never existed.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 h-9 px-3 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 active:scale-[0.98] transition-all duration-150"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
