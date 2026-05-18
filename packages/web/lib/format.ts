export type DateLike = Date | string | number;

/**
 * Coerce `Date | string | number | undefined` into a Date. JSON-bound
 * api responses arrive as strings even when their TypeScript types
 * claim `Date`; defensive callers pass them straight through helpers
 * like this one without manual `new Date(...)` wrapping. Returns
 * `undefined` for missing input (so callers can short-circuit) and
 * `undefined` for invalid input (so a bad value doesn't render as
 * "Invalid Date").
 */
export function toDate(value: DateLike | null | undefined): Date | undefined {
  if (value == null) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function formatRelativeTime(
  date: DateLike,
  now: Date = new Date(),
): string {
  const d = toDate(date);
  if (!d) return "—";
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.floor(diffMonth / 12)}y ago`;
}

export function shortId(id: string): string {
  const trimmed = id.replace(/^[a-z]+_/, "");
  return `#${trimmed.slice(0, 6)}`;
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
  // The full id starts with "sess_"; route URLs use the 6-char suffix.
  const sessionShort = sid.startsWith("sess_") ? sid.slice(5, 11) : sid.slice(0, 6);
  if (taskId) return `/tasks/${taskId}/sessions/${sessionShort}`;
  return `/sessions/${sessionShort}`;
}

/**
 * Duration between `startedAt` and `completedAt` (or `now` if running).
 * "30s" / "5m" / "1h 12m" / "2d 3h". Returns "—" if no start.
 */
export function formatDurationLabel(
  startedAt: DateLike | null | undefined,
  completedAt: DateLike | null | undefined,
  now: Date = new Date(),
): string {
  const start = toDate(startedAt);
  if (!start) return "—";
  const end = toDate(completedAt) ?? now;
  const diffSec = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const mins = min % 60;
  if (hr < 24) return mins ? `${hr}h ${mins}m` : `${hr}h`;
  const days = Math.floor(hr / 24);
  const hrs = hr % 24;
  return hrs ? `${days}d ${hrs}h` : `${days}d`;
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
