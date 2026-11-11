import { DetailShell } from "@/components/detail/detail-shell";
import { Skeleton } from "@/components/skeleton";

export default function EscalationDetailLoading() {
  return (
    <DetailShell>
      <Skeleton className="h-4 w-16 mb-3" />
      <div className="flex items-start justify-between gap-6 mb-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-6 w-20 rounded" />
      </div>
      <Skeleton className="h-24 w-full rounded-lg mb-6" />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
      <Skeleton className="h-56 w-full rounded-lg" />
    </DetailShell>
  );
}
