"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  FileText,
} from "lucide-react";
import { api, type WorkProductDetail } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "@/lib/hooks/keys";
import { DetailShell } from "@/components/detail/detail-shell";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { FooterField } from "@/components/detail/footer-field";
import { formatRelativeTime, shortId } from "@/lib/format";

export function WorkProductDetailClient({ workProductId }: { workProductId: string }) {
  const { data, isLoading, isError } = useQuery<WorkProductDetail>({
    queryKey: queryKeys.workProducts.detail(workProductId),
    queryFn: ({ signal }) => api.workProducts.get(workProductId, { signal }),
    enabled: isApiConfigured && !!workProductId,
    staleTime: 30_000,
  });

  if (!isApiConfigured) {
    return (
      <DetailShell>
        <EmptyState
          icon={FileText}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL and run the api server to load this work product."
        />
      </DetailShell>
    );
  }

  if (isLoading) {
    return (
      <DetailShell>
        <Skeleton className="h-14 w-full mb-6" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </DetailShell>
    );
  }

  if (isError || !data) {
    return (
      <DetailShell>
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load work product"
          description={`Work product ${workProductId} could not be fetched.`}
        />
      </DetailShell>
    );
  }

  return <Body wp={data} />;
}

function Body({ wp }: { wp: WorkProductDetail }) {
  const breadcrumbs = (
    <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4" aria-label="Breadcrumb">
      <Link href="/tasks" className="hover:text-foreground transition-colors">
        Tasks
      </Link>
      <ChevronRight className="h-3 w-3" />
      <Link
        href={`/tasks/${wp.task_id}`}
        className="hover:text-foreground transition-colors max-w-[18rem] truncate"
      >
        {wp.task_title}
      </Link>
      <ChevronRight className="h-3 w-3" />
      <span className="text-foreground/80 truncate max-w-[14rem]">{wp.title}</span>
    </nav>
  );

  // Body precedence: inlined file content > free-form summary. The
  // server tries to read file:// URLs from disk and inline them as
  // `body`; if that worked, prefer it. Otherwise fall back to summary
  // (which the agent typically writes as a structured markdown blob
  // anyway).
  const renderable = wp.body ?? wp.summary ?? "";

  return (
    <DetailShell nav={breadcrumbs}>
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

      <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
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
      </footer>
    </DetailShell>
  );
}
