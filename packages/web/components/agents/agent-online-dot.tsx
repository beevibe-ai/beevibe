"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type RuntimesListResponse } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { cn } from "@/lib/utils";

/**
 * Tiny status dot for an agent's preferred runtime.
 *
 * The hub's online flag for a runtime drives the color: green +
 * pulse-breathe when online, soft grey when offline or unknown. The
 * underlying query is shared via React Query — every dot on a page
 * resolves through one cached `GET /runtimes` round trip, and SSE
 * `runtime.updated` events refetch automatically (wired in M5.1).
 *
 * For agents without `preferred_runtime_id` (legacy seed fixtures), the
 * dot renders dim and titled "no runtime pinned" so the cause is
 * obvious on hover.
 */
export function AgentOnlineDot({
  preferredRuntimeId,
  size = "sm",
}: {
  /** From `agent.preferred_runtime_id`. Undefined for legacy / un-pinned agents. */
  preferredRuntimeId: string | undefined;
  size?: "sm" | "md";
}) {
  const query = useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    enabled: isApiConfigured && !!preferredRuntimeId,
    staleTime: 30_000,
  });

  const sizeClass = size === "md" ? "h-2 w-2" : "h-1.5 w-1.5";

  if (!preferredRuntimeId) {
    return (
      <span
        title="no runtime pinned"
        className={cn("inline-block rounded-full bg-muted-foreground/30", sizeClass)}
      />
    );
  }
  if (query.isLoading) {
    return (
      <span
        title="checking runtime…"
        className={cn(
          "inline-block rounded-full bg-muted-foreground/40 animate-pulse",
          sizeClass,
        )}
      />
    );
  }
  const runtime = findRuntime(query.data, preferredRuntimeId);
  if (!runtime) {
    return (
      <span
        title="runtime not found (revoked?)"
        className={cn("inline-block rounded-full bg-muted-foreground/30", sizeClass)}
      />
    );
  }
  const titleParts: string[] = [];
  titleParts.push(runtime.online ? "online" : "offline");
  if (runtime.cli_version) titleParts.push(`${runtime.cli} ${runtime.cli_version}`);
  return (
    <span
      title={titleParts.join(" · ")}
      className={cn(
        "inline-block rounded-full",
        runtime.online
          ? "bg-status-running animate-pulse-breathe"
          : "bg-muted-foreground/40",
        sizeClass,
      )}
    />
  );
}

function findRuntime(
  data: RuntimesListResponse | undefined,
  runtimeId: string,
): { online: boolean; cli: string; cli_version: string | null } | undefined {
  if (!data) return undefined;
  for (const d of data.daemons) {
    for (const r of d.runtimes) {
      if (r.id === runtimeId) {
        return { online: r.online, cli: r.cli, cli_version: r.cli_version ?? null };
      }
    }
  }
  return undefined;
}
