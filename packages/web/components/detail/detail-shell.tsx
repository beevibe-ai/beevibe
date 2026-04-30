import type { ReactNode } from "react";

export function DetailShell({ nav, children }: { nav?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {nav}
        {children}
      </div>
    </div>
  );
}
