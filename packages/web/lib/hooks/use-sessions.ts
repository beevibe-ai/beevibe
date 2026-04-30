import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useSession(shortId: string | undefined) {
  return useQuery({
    queryKey: shortId ? queryKeys.sessions.detail(shortId) : queryKeys.sessions.all,
    queryFn: ({ signal }) => api.sessions.get(shortId as string, { signal }),
    enabled: isApiConfigured && !!shortId,
  });
}
