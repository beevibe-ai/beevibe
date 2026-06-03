"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Handshake, Loader2 } from "lucide-react";
import { api, type AlignmentMeeting } from "@/lib/api/client";
import { describeError } from "@/lib/api/http";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { EmptyState } from "@/components/empty-state";

export function AlignmentClient() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.alignment.list(),
    queryFn: ({ signal }) => api.alignment.list({ signal }),
    enabled: isApiConfigured,
  });

  const start = useMutation({
    mutationFn: () => api.alignment.start(),
    onSuccess: (detail) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.alignment.all });
      router.push(`/alignment/${detail.meeting.id}`);
    },
  });

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto pt-8 pb-12 px-6">
        <div className="mb-6 flex items-start justify-between gap-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight mb-1">Alignment meetings</h1>
            <p className="text-sm text-muted-foreground max-w-prose leading-relaxed">
              Sit down with your team agent to see what each teammate believes,
              catch where anyone has drifted, and fix it on the spot — without
              reading through anyone&rsquo;s memory line by line.
            </p>
          </div>
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={start.isPending || !isApiConfigured}
            className="shrink-0 inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {start.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Gathering the team…
              </>
            ) : (
              <>
                <Handshake className="h-4 w-4" />
                Start a meeting
              </>
            )}
          </button>
        </div>

        {start.isError && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-[hsl(var(--status-failed))]/40 bg-[hsl(var(--status-failed))]/10 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-[hsl(var(--status-failed))]" />
            <span>{describeError(start.error)}</span>
          </div>
        )}

        <Body
          meetings={data?.meetings}
          isLoading={isLoading}
          isError={isError}
          onOpen={(id) => router.push(`/alignment/${id}`)}
        />
      </div>
    </div>
  );
}

function Body({
  meetings,
  isLoading,
  isError,
  onOpen,
}: {
  meetings: AlignmentMeeting[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onOpen: (id: string) => void;
}) {
  if (!isApiConfigured) {
    return (
      <EmptyState
        icon={Handshake}
        title="Not connected"
        description="Set NEXT_PUBLIC_BV_API_URL and run the API to hold alignment meetings."
      />
    );
  }
  if (isError) {
    return <EmptyState icon={AlertTriangle} title="Couldn't load meetings" />;
  }
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 rounded-md bg-secondary/30 animate-pulse" />
        ))}
      </div>
    );
  }
  if (!meetings || meetings.length === 0) {
    return (
      <EmptyState
        icon={Handshake}
        title="No meetings yet"
        description="Start one to get a plain-language read on every teammate and fix any drift."
      />
    );
  }
  return (
    <ul className="space-y-2">
      {meetings.map((m) => (
        <li key={m.id}>
          <button
            type="button"
            onClick={() => onOpen(m.id)}
            className="w-full text-left rounded-md border border-border/80 bg-background p-3.5 transition-colors hover:border-border hover:bg-secondary/30"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">
                Meeting · {new Date(m.created_at).toLocaleString()}
              </span>
              <StatusChip status={m.status} />
            </div>
            {m.notes.trim() && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {m.notes.trim()}
              </p>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function StatusChip({ status }: { status: AlignmentMeeting["status"] }) {
  const label =
    status === "active" ? "In progress" : status === "wrapped" ? "Wrapped" : "Preparing";
  return (
    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {label}
    </span>
  );
}
