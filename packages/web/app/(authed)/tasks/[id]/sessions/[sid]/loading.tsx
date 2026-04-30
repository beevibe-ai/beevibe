import { Skeleton } from "@/components/skeleton";

export default function SessionDetailLoading() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center gap-1.5 mb-4">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-3" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-3" />
          <Skeleton className="h-3 w-24" />
        </div>

        <header className="mb-6">
          <div className="flex items-start gap-3">
            <Skeleton className="h-10 w-10 rounded-full shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-72 rounded" />
                <Skeleton className="h-5 w-20 rounded" />
              </div>
              <Skeleton className="h-4 w-96" />
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Skeleton className="h-8 w-20 rounded" />
              <Skeleton className="h-8 w-8 rounded" />
            </div>
          </div>
        </header>

        <section className="rounded-lg border border-border bg-card overflow-hidden mb-5">
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-3 w-64" />
            </div>
            <Skeleton className="h-3 w-48" />
          </div>
          <div className="border-t border-border p-4 space-y-4">
            <div>
              <Skeleton className="h-3 w-32 mb-2" />
              <div className="ml-5 space-y-1.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-4/6" />
              </div>
            </div>
            <div>
              <Skeleton className="h-3 w-32 mb-2" />
              <div className="ml-5 space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <Skeleton className="h-3 w-24 mb-4" />
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-3 px-3 py-2 -mx-3">
                <Skeleton className="h-4 w-4 rounded shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
