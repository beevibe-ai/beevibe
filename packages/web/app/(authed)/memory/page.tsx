import type { Metadata } from "next";
import { MemoryClient } from "./memory-client";

export const metadata: Metadata = { title: "Memory" };

export default function MemoryPage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-6 px-6">
        <MemoryClient />
      </div>
    </div>
  );
}
