import { DetailShell } from "@/components/detail/detail-shell";
import { Skeleton } from "@/components/skeleton";

export default function NegotiationDetailLoading() {
  return (
    <DetailShell>
      <Skeleton className="h-4 w-16 mb-3" />
      <div className="flex items-start justify-between gap-6 mb-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-6 w-20 rounded" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    </DetailShell>
  );
}
