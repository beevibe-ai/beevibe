"use client";

import { cn } from "@/lib/utils";
import { MESH_WINDOWS, type MeshWindow } from "@/lib/types/mesh";

interface Props {
  value: MeshWindow;
  onChange: (value: MeshWindow) => void;
}

export function MeshWindowPills({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1 text-xs shrink-0">
      {MESH_WINDOWS.map((w) => {
        const active = value === w;
        return (
          <button
            key={w}
            type="button"
            onClick={() => onChange(w)}
            className={cn(
              "px-2 py-1 rounded transition-colors cursor-pointer",
              active
                ? "bg-secondary text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary",
            )}
          >
            {w === "all" ? "All time" : w}
          </button>
        );
      })}
    </div>
  );
}
