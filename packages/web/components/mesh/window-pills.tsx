"use client";

import { FilterPill } from "@/components/filter-pill";
import { MESH_WINDOWS, type MeshWindow } from "@/lib/types/mesh";

interface Props {
  value: MeshWindow;
  onChange: (value: MeshWindow) => void;
}

export function MeshWindowPills({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1 text-xs shrink-0">
      {MESH_WINDOWS.map((w) => (
        <FilterPill
          key={w}
          active={value === w}
          onClick={() => onChange(w)}
          className="px-2 py-1"
        >
          {w === "all" ? "All time" : w}
        </FilterPill>
      ))}
    </div>
  );
}
