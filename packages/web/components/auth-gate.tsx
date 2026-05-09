"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getUserKey, subscribeToUserKey } from "@/lib/api/config";
import { setOnUnauthorized } from "@/lib/api/http";

/**
 * Client-side auth gate for the (authed) segment. Bounces unauthed
 * visitors to /sign-in; sets up the 401-handler so a revoked /
 * malformed key automatically unwinds back to sign-in even mid-session.
 *
 * Implementation note: the redirect runs in an effect (not during
 * render) so SSR / Next.js prefetch don't infinite-loop. While the gate
 * is checking we render `null` — typically a single tick of black on
 * first paint, then either children or a redirect to /sign-in.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  // Initial check + subscribe to changes.
  useEffect(() => {
    setHasKey(getUserKey() !== null);
    return subscribeToUserKey(() => {
      setHasKey(getUserKey() !== null);
    });
  }, []);

  // Bounce on missing key.
  useEffect(() => {
    if (hasKey === false) {
      const next = pathname && pathname !== "/sign-in" ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/sign-in${next}`);
    }
  }, [hasKey, pathname, router]);

  // Wire a global 401 handler so any api request with an invalid key
  // unwinds to sign-in without us needing to thread the redirect
  // through every hook.
  useEffect(() => {
    setOnUnauthorized(() => {
      // Clear via the proper helper so subscribers (SSE etc.) get the
      // reset signal.
      if (typeof window !== "undefined") {
        window.localStorage.removeItem("bv:user_key");
      }
      const next = pathname ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/sign-in${next}`);
    });
  }, [pathname, router]);

  if (hasKey !== true) return null;
  return <>{children}</>;
}
