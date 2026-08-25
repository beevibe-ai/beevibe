"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FileText } from "lucide-react";
import { api, type WorkProductDetail } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { DetailGate } from "@/components/detail/detail-gate";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { FooterField } from "@/components/detail/footer-field";
import { DetailFooter } from "@/components/detail/detail-footer";
import { TaskBreadcrumbs } from "@/components/detail/task-breadcrumbs";
import { formatRelativeTime, shortId } from "@/lib/format";

export function WorkProductDetailClient({ workProductId }: { workProductId: string }) {
  const query = useQuery<WorkProductDetail>({
    queryKey: queryKeys.workProducts.detail(workProductId),
    queryFn: ({ signal }) => api.workProducts.get(workProductId, { signal }),
    enabled: isApiConfigured && !!workProductId,
    staleTime: 30_000,
  });

  return (
    <DetailGate
      // The breadcrumb names the parent task, so it can only be drawn once
      // the row is in hand — the pre-data states render without one.
      nav={
        query.data ? (
          <TaskBreadcrumbs
            taskId={query.data.task_id}
            taskTitle={query.data.task_title}
            leaf={query.data.title}
          />
        ) : undefined
      }
      icon={FileText}
      noun="work product"
      id={workProductId}
      query={query}
      skeleton={
        <>
          <Skeleton className="h-14 w-full mb-6" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </>
      }
    >
      {(wp) => <Body wp={wp} />}
    </DetailGate>
  );
}

function Body({ wp }: { wp: WorkProductDetail }) {
  // Body precedence: inlined file content > free-form summary. The
  // server tries to read file:// URLs from disk and inline them as
  // `body`; if that worked, prefer it. Otherwise fall back to summary
  // (which the agent typically writes as a structured markdown blob
  // anyway).
  const renderable = wp.body ?? wp.summary ?? "";

  return (
    <>
      <header className="mb-5">
        <div className="flex items-center gap-2 mb-2">
          <Link
            href={`/tasks/${wp.task_id}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to task
          </Link>
          <span className="text-muted-foreground/50 text-xs">·</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {wp.type.replace(/_/g, " ")}
          </span>
        </div>
        <h1 className="text-base font-semibold tracking-tight leading-tight">{wp.title}</h1>
        <div className="mt-1.5 text-xs text-muted-foreground">
          By <span className="text-foreground/85">{wp.agent_label}</span>{" "}
          · updated {formatRelativeTime(wp.updated_at)}
        </div>
      </header>

      {/* External link — but only when the URL is something the browser can
          actually follow. file:// URLs from agent workspaces don't work
          across origins, so we surface those as plain text in the footer. */}
      {wp.url && !wp.url_is_local ? (
        <a
          href={wp.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-5 inline-flex items-center gap-1.5 rounded-md border border-border hover:bg-secondary px-3 py-1.5 text-xs font-medium transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          {wp.provider ? `Open in ${wp.provider}` : "Open"}
        </a>
      ) : null}

      {renderable ? (
        <article className="rounded-lg border border-border bg-card p-5">
          <ChatMarkdown content={renderable} />
        </article>
      ) : (
        <EmptyState
          icon={FileText}
          title="No content"
          description="This work product is a stub — the agent didn't attach a body or a reachable URL."
        />
      )}

      <DetailFooter>
        <FooterField label="ID">
          <ClickToCopyId id={wp.id} />
        </FooterField>
        <FooterField label="Task" truncate>
          <Link
            href={`/tasks/${wp.task_id}`}
            className="font-mono hover:text-foreground transition-colors"
          >
            {shortId(wp.task_id)}
          </Link>
        </FooterField>
        {wp.url ? (
          <FooterField label={wp.url_is_local ? "Stored at (host)" : "URL"} truncate>
            <span className="font-mono">{wp.url}</span>
          </FooterField>
        ) : null}
        {wp.provider ? <FooterField label="Provider">{wp.provider}</FooterField> : null}
      </DetailFooter>
    </>
  );
}
