import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * `Tasks › <task> › <leaf>` breadcrumb, for the detail pages that hang off
 * a task — the task-scoped session view and the work-product view. Both had
 * their own `Breadcrumbs` local component with the same three-crumb markup
 * and the same chevron/truncation classes.
 *
 * `taskTitle` is nullable because the session page draws the trail before
 * its query resolves; it falls back to the task's short id.
 */
export function TaskBreadcrumbs({
  taskId,
  taskTitle,
  leaf,
  leafMono,
}: {
  taskId: string;
  taskTitle: string | null;
  /** Final, non-linked crumb — the thing the page is showing. */
  leaf: string;
  /** Render the leaf monospaced (ids read better that way than titles). */
  leafMono?: boolean;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4"
    >
      <Link href="/tasks" className="hover:text-foreground transition-colors">
        Tasks
      </Link>
      <ChevronRight className="h-3 w-3" />
      <Link
        href={`/tasks/${taskId}`}
        className="hover:text-foreground transition-colors max-w-[18rem] truncate"
      >
        {taskTitle ?? shortId(taskId)}
      </Link>
      <ChevronRight className="h-3 w-3" />
      <span
        className={cn("text-foreground/80", leafMono ? "font-mono" : "truncate max-w-[14rem]")}
      >
        {leaf}
      </span>
    </nav>
  );
}
