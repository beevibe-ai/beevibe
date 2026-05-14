"use client";

import { useState } from "react";
import { FileCode, FileJson, FileText, Image as ImageIcon, FileQuestion } from "lucide-react";
import type { Artifact } from "@/lib/fixtures/repo-runs";
import { formatBytes } from "@/lib/fixtures/repo-runs";
import { ChatMarkdown } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";

const KIND_ICON = {
  markdown: FileText,
  json: FileJson,
  text: FileCode,
  image: ImageIcon,
  binary: FileQuestion,
} as const;

export function ArtifactPreview({ artifacts }: { artifacts: Artifact[] }) {
  const [openId, setOpenId] = useState<string | null>(
    artifacts[0]?.id ?? null,
  );

  if (artifacts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No artifacts produced.
      </p>
    );
  }

  const open = artifacts.find((a) => a.id === openId) ?? artifacts[0];

  return (
    <div className="grid grid-cols-[200px_1fr] gap-3">
      <ul className="space-y-1">
        {artifacts.map((a) => {
          const Icon = KIND_ICON[a.kind];
          const active = a.id === open.id;
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setOpenId(a.id)}
                className={cn(
                  "w-full text-left flex items-center gap-2 rounded px-2 py-1.5 transition-colors cursor-pointer",
                  active
                    ? "bg-secondary text-foreground"
                    : "hover:bg-secondary/40 text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 min-w-0 truncate text-xs">
                  {a.title}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
                  {formatBytes(a.size_bytes)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="min-w-0 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3 mb-3 pb-2 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">{open.title}</span>
            <span className="font-mono text-[10px] text-muted-foreground truncate">
              {open.path}
            </span>
          </div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
            {open.kind}
          </span>
        </div>

        <ArtifactBody artifact={open} />
      </div>
    </div>
  );
}

function ArtifactBody({ artifact }: { artifact: Artifact }) {
  if (artifact.preview === null) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Binary artifact — preview unavailable. Download to inspect.
      </p>
    );
  }

  if (artifact.kind === "markdown") {
    return (
      <div className="text-foreground/90">
        <ChatMarkdown content={artifact.preview} />
      </div>
    );
  }

  if (artifact.kind === "json") {
    return (
      <pre className="text-xs leading-relaxed font-mono text-foreground/85 overflow-x-auto">
        {artifact.preview}
      </pre>
    );
  }

  return (
    <pre className="text-xs leading-relaxed font-mono text-foreground/85 whitespace-pre-wrap break-words">
      {artifact.preview}
    </pre>
  );
}
