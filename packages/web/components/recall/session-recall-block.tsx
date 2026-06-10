"use client";

import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  XCircle,
} from "lucide-react";
import { formatRelativeTime, sessionHref } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Rich render for a `session_search` discover result — the moment the
 * agent reaches back into Layer-3 memory and pulls up a past
 * conversation. The visual analogue of MeshAskBlock for memory recall.
 *
 * Rendered in two contexts:
 *   - chat live panel (top hit only, compact)
 *   - session-detail transcript (all hits, fuller)
 *
 * The block is purely presentational — it takes a pre-parsed discover
 * result. Callers handle the safe-parse step because the tool_result
 * shape differs between SSE-streamed payloads (truncated at 512 chars)
 * and DB-served TranscriptEntry rows (full content).
 */

// ── Types — kept structurally compatible with @beevibe/core's
// SessionSearchResult so a (well-typed) parser can hand the result in
// directly. We don't import from @beevibe/core because the web package
// keeps its types narrow; over-coupling makes the bundle larger.

export interface RecallMsg {
  id: string;
  session_id: string;
  kind: "user" | "agent" | "tool_call" | "tool_result" | "summary";
  content: string;
  timestamp?: string;
  created_at?: string;
}

export interface RecallHit {
  session: {
    session_id: string;
    conversation_id: string | null;
    type: string;
    status: string;
    agent_id: string;
    task_id: string | null;
    intent_preview: string;
    created_at: string;
    completed_at: string | null;
    result_summary: string | null;
  };
  match_message_id: string;
  matched_role: string;
  snippet: string;
  bookend_start: RecallMsg[];
  messages: RecallMsg[];
  bookend_end: RecallMsg[];
  messages_before?: number;
  messages_after?: number;
}

export interface RecallDiscover {
  kind: "discover";
  query: string;
  hits: RecallHit[];
  lineages_searched?: number;
}

/** Type guard so callers can branch on whatever they parsed. */
export function isRecallDiscover(value: unknown): value is RecallDiscover {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== "discover") return false;
  if (typeof v.query !== "string") return false;
  if (!Array.isArray(v.hits)) return false;
  return true;
}

/**
 * Try-parse a tool_result content string into a discover result. Returns
 * null when the content is not a valid discover payload, when it is
 * truncated mid-array such that no hits could be extracted, or when the
 * top-level kind is anything else (scroll/read/browse — those don't get
 * the rich card).
 */
export function parseRecallContent(content: string): RecallDiscover | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecallDiscover(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface Props {
  result: RecallDiscover;
  /**
   * Cap rendered hits. Chat live panel passes 1 (compact); transcript
   * passes Infinity-ish (default 5).
   */
  maxHits?: number;
  /** Compact mode — hides bookends, snippet only. */
  dense?: boolean;
}

export function SessionRecallBlock({ result, maxHits = 5, dense = false }: Props) {
  if (result.hits.length === 0) return null;
  const shown = result.hits.slice(0, Math.max(1, maxHits));
  const more = result.hits.length - shown.length;

  return (
    <div
      className={cn(
        "rounded-lg border border-status-running/25 bg-status-running/5",
        dense ? "p-3" : "p-4",
      )}
    >
      <div className="flex items-center gap-2 text-xs mb-3">
        <History className="h-3.5 w-3.5 text-status-running" />
        <span className="font-medium">Past conversation</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground truncate">"{result.query}"</span>
        <span className="ml-auto text-[10px] text-muted-foreground font-mono">
          {result.hits.length} match{result.hits.length === 1 ? "" : "es"}
        </span>
      </div>

      <ul className={cn("space-y-3", dense && "space-y-2")}>
        {shown.map((hit) => (
          <li key={hit.match_message_id}>
            <RecallHitRow hit={hit} dense={dense} />
          </li>
        ))}
      </ul>

      {more > 0 && (
        <div className="mt-2 text-[10px] text-muted-foreground/70">
          + {more} more match{more === 1 ? "" : "es"}
        </div>
      )}
    </div>
  );
}

// ── Single-hit row ──────────────────────────────────────────────────

function RecallHitRow({ hit, dense }: { hit: RecallHit; dense: boolean }) {
  const StatusIcon = hit.session.status === "succeeded" ? CheckCircle2 : XCircle;
  const statusTone =
    hit.session.status === "succeeded"
      ? "text-status-done"
      : hit.session.status === "failed"
        ? "text-status-failed"
        : "text-muted-foreground";

  const href = sessionHref(
    hit.session.session_id,
    hit.session.task_id ?? undefined,
  );
  const goal = pickGoal(hit.bookend_start);
  const resolution = pickResolution(hit.bookend_end, hit.bookend_start);

  return (
    <div className="rounded-md bg-card border border-border/60 p-3">
      <div className="flex items-center gap-2 text-[11px] mb-2">
        <StatusIcon className={cn("h-3.5 w-3.5", statusTone)} />
        <span className="font-medium capitalize">{hit.session.type}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground inline-flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatRelativeTime(hit.session.created_at)}
        </span>
        <Link
          href={href}
          className="ml-auto inline-flex items-center gap-1 text-status-running hover:underline"
        >
          open
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      <p
        className="text-sm leading-relaxed text-foreground/85 mb-2"
        // Snippet is generated server-side via ts_headline with the default
        // <b>…</b> highlight markers. The HTML is from a trusted boundary
        // (our own SQL) so direct rendering is safe; the alternative — a
        // custom parser — would add code without changing the threat model.
        dangerouslySetInnerHTML={{ __html: hit.snippet }}
      />

      {!dense && (goal || resolution) && (
        <div className="space-y-1.5 mt-2 pt-2 border-t border-border/45 text-[12px]">
          {goal && (
            <div className="flex items-start gap-2">
              <ArrowUpRight className="h-3 w-3 text-muted-foreground/70 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">
                  Goal
                </span>
                <span className="text-foreground/75">{goal}</span>
              </div>
            </div>
          )}
          {resolution && (
            <div className="flex items-start gap-2">
              <ArrowDownRight className="h-3 w-3 text-muted-foreground/70 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">
                  End
                </span>
                <span className="text-foreground/75">{resolution}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Bookend selection ────────────────────────────────────────────────

/**
 * The "goal" line is the first user turn — that's the request the agent
 * was given. Falls back to the first significant message of any kind so
 * we always have something useful even if the bookend is degenerate.
 */
function pickGoal(bookendStart: RecallMsg[]): string {
  const firstUser = bookendStart.find((m) => m.kind === "user");
  const pick = firstUser ?? bookendStart[0];
  return pick ? trimBookend(pick.content) : "";
}

/**
 * The "end" line is the last agent turn — that's the agent's last word
 * before the session terminated. Skips messages we already showed in
 * the goal so a 2-message session doesn't duplicate them.
 */
function pickResolution(bookendEnd: RecallMsg[], bookendStart: RecallMsg[]): string {
  const startIds = new Set(bookendStart.map((m) => m.id));
  const lastAgent = [...bookendEnd].reverse().find(
    (m) => m.kind === "agent" && !startIds.has(m.id),
  );
  const pick = lastAgent ?? bookendEnd[bookendEnd.length - 1];
  if (!pick || startIds.has(pick.id)) return "";
  return trimBookend(pick.content);
}

function trimBookend(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 140 ? cleaned.slice(0, 137) + "…" : cleaned;
}
