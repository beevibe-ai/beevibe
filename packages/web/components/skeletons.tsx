import { Skeleton } from "./skeleton";

export function FactRowSkeleton() {
  return (
    <tr>
      <td className="px-3 py-3 align-top">
        <Skeleton className="h-3.5 w-3.5 rounded" />
      </td>
      <td className="px-3 py-3 space-y-1.5">
        <Skeleton className="h-4 w-full max-w-2xl" />
        <Skeleton className="h-4 w-3/4" />
      </td>
      <td className="px-3 py-3 align-middle">
        <Skeleton className="h-5 w-16 rounded" />
      </td>
      <td className="px-3 py-3 align-middle">
        <Skeleton className="h-4 w-10 rounded" />
      </td>
      <td className="px-3 py-3 align-middle">
        <Skeleton className="h-3 w-24" />
      </td>
      <td className="px-3 py-3 align-middle">
        <Skeleton className="h-3 w-12" />
      </td>
      <td />
    </tr>
  );
}

export function KpiTileSkeleton() {
  return (
    <div className="block">
      <Skeleton className="h-3 w-24 mb-1.5" />
      <div className="flex items-baseline gap-2">
        <Skeleton className="h-8 w-12" />
        <Skeleton className="h-4 w-12" />
      </div>
      <Skeleton className="h-3 w-32 mt-2" />
      <Skeleton className="h-6 w-full mt-2" />
    </div>
  );
}

export function PromotionEventSkeleton() {
  return (
    <div className="relative py-4 border-b border-border">
      <div className="absolute -left-7 top-5 h-6 w-6 rounded-full bg-background border-2 border-border" />
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-10 rounded" />
          <Skeleton className="h-3 w-3 rounded" />
          <Skeleton className="h-5 w-12 rounded" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-3 w-12" />
      </div>
      <div className="space-y-1.5 mb-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
      <div className="rounded-lg bg-secondary/50 p-3 space-y-1.5 mb-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
      <Skeleton className="h-3 w-64" />
    </div>
  );
}

export function MeshAskSkeleton() {
  return (
    <div className="block rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-3 rounded" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-20 rounded ml-auto" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <Skeleton className="h-3 w-72" />
    </div>
  );
}
