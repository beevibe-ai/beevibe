"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, MessageCircleMore, Plus, Users } from "lucide-react";
import { api, type Room } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { formatRelativeTime, shortId } from "@/lib/format";

export function RoomsListClient() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<{ ok: true; rooms: Room[] }>({
    queryKey: queryKeys.rooms.list(),
    queryFn: ({ signal }) => api.rooms.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 10_000,
  });

  const create = useMutation({
    mutationFn: () => api.rooms.create({ name: name.trim() }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rooms.all });
      router.push(`/rooms/${res.room.id}`);
    },
    onError: (err) => setError((err as Error).message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    create.mutate();
  };

  if (!isApiConfigured) {
    return (
      <div className="p-6">
        <EmptyState
          icon={MessageCircleMore}
          title="Web isn't configured"
          description="Set NEXT_PUBLIC_BV_API_URL and run the api server."
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-2xl mx-auto">
        <header className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight">Rooms</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-prose">
            Shared spaces where multiple humans collaborate alongside their team agents. Invite
            a teammate by email — their team agent joins the room, and yours can ask theirs
            questions directly via mesh.
          </p>
        </header>

        <form
          onSubmit={submit}
          className="mb-6 flex items-end gap-2 bg-card border border-border rounded-lg p-3"
        >
          <div className="flex-1">
            <label htmlFor="room-name" className="block text-xs font-medium text-foreground mb-1.5">
              Create a new room
            </label>
            <input
              id="room-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Plan the M9 launch"
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={create.isPending}
            />
          </div>
          <button
            type="submit"
            disabled={create.isPending || name.trim().length === 0}
            className="h-9 inline-flex items-center gap-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity px-3 text-sm font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Create
          </button>
        </form>
        {error ? (
          <div className="mb-4 flex items-start gap-1.5 text-xs text-status-failed">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
          Your rooms
        </h2>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : isError ? (
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load rooms"
            description="Check that the api server is reachable."
          />
        ) : (data?.rooms ?? []).length === 0 ? (
          <EmptyState
            icon={Users}
            title="No rooms yet"
            description="Create a room above and invite a teammate by email."
          />
        ) : (
          <ul className="space-y-2">
            {(data?.rooms ?? []).map((r) => (
              <li key={r.id}>
                <Link
                  href={`/rooms/${r.id}`}
                  className="block rounded-lg border border-border bg-card p-3 hover:bg-secondary/30 transition-colors"
                >
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-semibold flex-1 min-w-0 truncate">{r.name}</h3>
                    <span className="text-[10px] tabular-nums text-muted-foreground/80 shrink-0">
                      {formatRelativeTime(r.updated_at)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                    {shortId(r.id)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
