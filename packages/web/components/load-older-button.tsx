export function LoadOlderButton({ label }: { label: string }) {
  return (
    <div className="mt-4 text-center">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium hover:bg-secondary cursor-pointer transition-colors text-muted-foreground hover:text-foreground"
      >
        {label}
      </button>
    </div>
  );
}
