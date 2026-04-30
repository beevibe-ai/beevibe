import { Skeleton } from "@/components/skeleton";

export default function TaskDetailLoading() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <Skeleton className="h-4 w-16 mb-3" />

        <div className="flex items-start justify-between gap-6 mb-1.5">
          <Skeleton className="h-8 flex-1 max-w-2xl" />
          <div className="flex items-center gap-1.5 mt-1.5">
            <Skeleton className="h-6 w-20 rounded" />
            <Skeleton className="h-6 w-12 rounded" />
          </div>
        </div>

        <Skeleton className="h-4 w-2/3 mb-5" />

        <div className="flex justify-end gap-2 mb-6">
          <Skeleton className="h-9 w-20 rounded" />
          <Skeleton className="h-9 w-32 rounded" />
          <Skeleton className="h-9 w-24 rounded" />
        </div>

        <div className="border-b border-border mb-6">
          <div className="flex items-center gap-1 -mb-px py-2">
            <Skeleton className="h-5 w-16 rounded" />
            <Skeleton className="h-5 w-20 rounded ml-3" />
            <Skeleton className="h-5 w-24 rounded ml-3" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-5">
            <section className="rounded-lg border border-border bg-card p-5">
              <Skeleton className="h-3 w-20 mb-3" />
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-4 w-5/6 mb-2" />
              <Skeleton className="h-4 w-4/6" />
            </section>
            <section className="rounded-lg border border-border bg-card p-5">
              <Skeleton className="h-3 w-24 mb-3" />
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-4 w-3/4" />
            </section>
          </div>
          <aside className="col-span-1 space-y-4">
            <section className="rounded-lg border border-border bg-card p-4">
              <Skeleton className="h-3 w-24 mb-3" />
              <div className="flex items-center justify-between mb-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-16 rounded" />
              </div>
              <Skeleton className="h-3 w-32" />
            </section>
            <section className="rounded-lg border border-dashed border-border p-4">
              <Skeleton className="h-3 w-24 mx-auto" />
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
