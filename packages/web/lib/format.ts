/**
 * Web-side display helpers.
 *
 * The ones the api also needs — `deriveShortId`, the relative-time
 * ladder, `formatDurationLabel` — live in `@beevibe/core`
 * and are re-exported here so existing `@/lib/format` imports keep
 * working. They used to be a hand-kept parallel copy of
 * `packages/api/src/views/format.ts`; `deriveShortId` in particular
 * decides both the `short_id` the api serializes and the URL fragment
 * the web navigates to, so the two drifting apart would produce dead
 * links.
 */

import { deriveShortId, formatRelative, type DateLike } from "@beevibe/core/domain/format";

export { deriveShortId, formatDurationLabel } from "@beevibe/core/domain/format";

/** Relative-time label in prose form: "just now" / "2m ago" / "3d ago". */
export function formatRelativeTime(date: DateLike, now: Date = new Date()): string {
  return formatRelative(date, { now, suffix: " ago" });
}

export function shortId(id: string): string {
  return `#${deriveShortId(id)}`;
}

/** Cap a string at `n` chars, adding an ellipsis suffix when truncated. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Session intents for task work are wrapped as `<task id="...">title\n\ndescription</task>`
 * (or self-closing `<task id="..."/>` for lifecycle reminders). Strip the
 * wrapper for display so the UI shows the human-readable title, not raw XML.
 * Chat intents (no wrapper) pass through unchanged.
 */
export function formatIntent(intent: string): string {
  const selfClosing = intent.match(/^\s*<task id="[^"]*"\/>\s*$/);
  if (selfClosing) return "Lifecycle reminder";
  const wrapped = intent.match(/^\s*<task id="[^"]*">\s*([\s\S]*?)\s*<\/task>\s*$/);
  if (wrapped) {
    const inner = wrapped[1];
    const firstBlock = inner.split(/\n\n/)[0] ?? inner;
    return firstBlock.trim();
  }
  return intent;
}

/**
 * Strip the typed-id prefix and return what's left — used as the
 * stable "@token" form for room mentions and as the short URL
 * fragment in the conversation sidebar. e.g. `agent_kBpTkqiCbsB3` →
 * `kBpTkqiCbsB3`. Falls back to the full id when there's no
 * underscore (which shouldn't happen for typed ids, but cheap to
 * guard).
 */
export function idSuffix(id: string): string {
  const i = id.indexOf("_");
  return i < 0 ? id : id.slice(i + 1) || id;
}

export function sessionHref(sid: string, taskId?: string): string {
  const sessionShort = deriveShortId(sid);
  if (taskId) return `/tasks/${taskId}/sessions/${sessionShort}`;
  return `/sessions/${sessionShort}`;
}

/**
 * Display label for an agent's `review_policy`. Anything other than the
 * `require_human` sentinel renders as "auto-done" — covers null/undefined
 * legacy agents (pre-PR #102) AND the explicit "auto_done" value. The
 * input is widened to `string | null | undefined` because the AgentDisplay
 * view shape stringifies the column for JSON serialization.
 */
export function formatReviewPolicy(policy: string | null | undefined): string {
  return policy === "require_human" ? "require human" : "auto-done";
}
