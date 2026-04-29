import { Skeleton } from "./skeleton";

export function TaskRowSkeleton() {
  return (
    <li className="flex items-start gap-3 px-6 py-3">
      <Skeleton className="h-4 w-4 mt-0.5 shrink-0 rounded-full" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-baseline gap-2">
          <Skeleton className="h-4 flex-1 max-w-md" />
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    </li>
  );
}

export function TaskListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <ul>
      {Array.from({ length: rows }).map((_, i) => (
        <TaskRowSkeleton key={i} />
      ))}
    </ul>
  );
}

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

export function FactTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, i) => (
        <FactRowSkeleton key={i} />
      ))}
    </tbody>
  );
}

export function TranscriptEntrySkeleton() {
  return (
    <div className="flex items-start gap-3 px-3 py-2 -mx-3">
      <Skeleton className="h-4 w-4 rounded shrink-0 mt-0.5" />
      <div className="flex-1 space-y-1">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
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

export function ChannelLinkSkeleton() {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded">
      <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
      <Skeleton className="h-3 flex-1 max-w-[180px]" />
      <Skeleton className="h-2.5 w-6 shrink-0" />
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
