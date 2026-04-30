import { AtSign, Check, GitBranch, Paperclip, RotateCcw, X } from "lucide-react";

export function ThreadActionFooter() {
  return (
    <footer className="px-6 py-3 shrink-0">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 h-9 px-4 rounded bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-150 cursor-pointer"
          >
            <Check className="h-4 w-4" />
            Approve
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 h-9 px-3 rounded text-sm font-medium hover:bg-secondary cursor-pointer transition-all duration-150"
          >
            <RotateCcw className="h-4 w-4" />
            Request revisions
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 h-9 px-3 rounded text-sm font-medium text-status-failed hover:bg-status-failed/10 cursor-pointer transition-all duration-150"
          >
            <X className="h-4 w-4" />
            Reject
          </button>
          <span className="ml-auto text-xs text-muted-foreground">
            ↵ to send · /agent to delegate
          </span>
        </div>
        <div className="rounded-md bg-secondary/50 px-3 py-2.5 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 transition-shadow">
          <textarea
            rows={1}
            placeholder="Reply to ic-agent-1, or note for the next session…"
            className="w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none resize-none"
          />
          <div className="flex items-center gap-2 mt-1">
            <button
              type="button"
              title="Attach"
              aria-label="Attach"
              className="h-6 w-6 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Mention agent"
              aria-label="Mention agent"
              className="h-6 w-6 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <AtSign className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Delegate as new task"
              className="h-6 px-2 rounded inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <GitBranch className="h-3 w-3" />
              Delegate
            </button>
            <span className="ml-auto text-[10px] text-muted-foreground">
              creates a chat-type session targeting{" "}
              <span className="font-mono">ic-agent-1</span>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
