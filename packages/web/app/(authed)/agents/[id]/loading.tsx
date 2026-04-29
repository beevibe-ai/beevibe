import { Skeleton } from "@/components/skeleton";

export default function AgentDetailLoading() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <Skeleton className="h-4 w-20 mb-3" />

        <header className="mb-6">
          <div className="flex items-start gap-4">
            <Skeleton className="h-14 w-14 rounded-full shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-6 w-40 rounded" />
                <Skeleton className="h-5 w-10 rounded" />
                <Skeleton className="h-5 w-20 rounded" />
              </div>
              <Skeleton className="h-4 w-72" />
            </div>
            <Skeleton className="h-8 w-24 rounded shrink-0" />
          </div>

          <div className="grid grid-cols-4 gap-x-8 mt-6 pt-6 border-t border-border">
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <Skeleton className="h-3 w-20 mb-2" />
                <Skeleton className="h-7 w-12" />
              </div>
            ))}
          </div>
        </header>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-5">
            <section>
              <Skeleton className="h-4 w-40 mb-3" />
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start gap-3">
                      <Skeleton className="h-12 w-12 rounded-full shrink-0" />
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center gap-2">
                          <Skeleton className="h-3 w-16" />
                          <Skeleton className="h-3 w-32" />
                        </div>
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-5/6" />
                        <Skeleton className="h-3 w-3/4" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <Skeleton className="h-4 w-44 mb-3" />
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-border bg-card p-3 flex items-start gap-3"
                  >
                    <div className="flex flex-col gap-1">
                      <Skeleton className="h-5 w-16 rounded" />
                      <Skeleton className="h-3 w-8 rounded" />
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-4/5" />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="col-span-1 space-y-4">
            <section className="rounded-lg border border-border bg-card p-4">
              <Skeleton className="h-3 w-24 mb-3" />
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-3 w-32" />
            </section>
            <section className="rounded-lg border border-dashed border-border p-4">
              <Skeleton className="h-3 w-32 mx-auto" />
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
