import { BookmarkCheck, ExternalLink } from "lucide-react";
import type { SavedTool } from "@/lib/fixtures/repo-runs";
import { shortRepoLabel } from "@/lib/fixtures/repo-runs";
import { formatRelativeTime } from "@/lib/format";

/**
 * "Saved tools" on the agent detail page. Rendered only when the agent
 * has at least one — keeps the page quiet for agents with none.
 */
export function AgentSavedToolsSection({
  tools,
}: {
  tools: SavedTool[];
}) {
  if (tools.length === 0) return null;
  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
        Saved tools{" "}
        <span className="text-muted-foreground/70 tabular-nums">
          {tools.length}
        </span>
      </h2>
      <div className="space-y-2">
        {tools.map((t) => (
          <SavedToolCard key={t.name} tool={t} />
        ))}
      </div>
    </section>
  );
}

export function SavedToolCard({ tool }: { tool: SavedTool }) {
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <BookmarkCheck className="h-4 w-4 text-status-done mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium leading-tight mb-0.5">
            {tool.display_name}
          </h3>
          <p className="text-xs text-muted-foreground mb-2">
            {tool.description}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
            <a
              href={tool.repo_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <span className="font-mono">
                {shortRepoLabel(tool.repo_url)}
              </span>
              <ExternalLink className="h-3 w-3" />
            </a>
            <span>·</span>
            <span>used {tool.use_count}×</span>
            <span>·</span>
            <span>last {formatRelativeTime(tool.last_used_at)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
