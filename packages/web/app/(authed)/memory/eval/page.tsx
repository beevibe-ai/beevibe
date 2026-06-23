import type { Metadata } from "next";
import { MemoryEvalClient } from "./eval-client";

export const metadata: Metadata = { title: "Memory · Eval" };

export default function MemoryEvalPage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-12 px-6">
        <MemoryEvalClient />
      </div>
    </div>
  );
}
