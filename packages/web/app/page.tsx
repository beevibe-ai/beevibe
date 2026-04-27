export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2.5">
          <span className="h-7 w-7 rounded bg-primary inline-flex items-center justify-center text-primary-foreground text-base font-bold">
            b
          </span>
          <span className="text-2xl font-semibold tracking-tight">beevibe</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Web package scaffolded. Pages coming next.
        </p>
      </div>
    </main>
  );
}
