/**
 * Display formatters shared by the api's view layer and the web app.
 *
 * These four were maintained as parallel copies in
 * `packages/api/src/views/format.ts` and `packages/web/lib/format.ts`,
 * with a comment on each side pointing at the other and asking that
 * they be kept in sync. That is a drift risk with teeth: `deriveShortId`
 * decides both the `short_id` the api serializes and the 6-char
 * fragment the web puts in a URL, so a change on one side alone
 * produces links that 404.
 *
 * Everything here is pure and dependency-free — safe to pull into the
 * browser bundle, which is why it lives in `domain/` rather than in a
 * service.
 *
 * IMPORT THIS VIA `@beevibe/core/domain/format`, NOT the package root.
 * The root barrel re-exports `./auth`, which reaches for `node:crypto`
 * and `node:util`; a *value* import of the root from a client component
 * drags those into webpack and fails `next build` with
 * `UnhandledSchemeError: Reading from "node:crypto" is not handled by
 * plugins`. Type-only root imports are fine — they erase — which is why
 * the rest of the web app gets away with `import type { … } from
 * "@beevibe/core"`. This module is the first runtime value the web
 * pulls out of core, hence the dedicated export subpath.
 */

export type DateLike = Date | string | number;

/**
 * Coerce `Date | string | number` into a Date.
 *
 * JSON-bound api responses arrive as strings even when their TypeScript
 * types claim `Date`, so callers pass values straight through without
 * wrapping. Returns undefined for missing input (so callers can
 * short-circuit) and for unparseable input (so a bad value renders as a
 * placeholder rather than the literal text "Invalid Date").
 */
export function toDate(value: DateLike | null | undefined): Date | undefined {
  if (value == null) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Strip the type prefix (`sess_`, `agent_`, …) and take the first 6
 * chars. This is the id form that appears in routes and lookups on both
 * sides, which is why it must be one function.
 */
export function deriveShortId(id: string): string {
  return id.replace(/^[a-z]+_/, "").slice(0, 6);
}

/**
 * Cap a string at `n` characters, ellipsis included — `truncate(s, 80)`
 * never returns more than 80 chars.
 *
 * The web had this as `truncate` in `lib/format.ts`; the api wrote the
 * same expression out longhand in two places that build the *same*
 * field — the chat-thread `title`, once in `views/agents.ts` for the
 * agent detail page and once in `routes/chat.ts` for the conversation
 * list. Those two disagreeing would show one thread under two different
 * titles depending on which page you were looking at, which is exactly
 * the drift the rest of this module exists to prevent.
 *
 * Note this is not the only truncation idiom in the tree: several call
 * sites use `s.length > n ? s.slice(0, n - 3) + "…"`, which caps at
 * `n - 2`. That is a different (probably accidental) contract, so those
 * sites are deliberately left alone rather than silently re-lengthened.
 */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Relative-time label: "just now", "2m", "1h", "3d", "5mo", "1y".
 *
 * The api serializes the bare form into `age` / `elapsed` fields; the
 * web renders "2m ago" in prose. Same six thresholds either way, so
 * `suffix` is the only thing that varies — previously the whole ladder
 * was written out twice.
 */
export function formatRelative(
  date: DateLike,
  opts: { now?: Date; suffix?: string } = {},
): string {
  const { now = new Date(), suffix = "" } = opts;
  const d = toDate(date);
  if (!d) return "—";

  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";

  const tail = (n: number, unit: string) => `${n}${unit}${suffix}`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return tail(diffMin, "m");
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return tail(diffHr, "h");
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return tail(diffDay, "d");
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return tail(diffMonth, "mo");
  return tail(Math.floor(diffMonth / 12), "y");
}

/**
 * Duration between `startedAt` and `completedAt` (or `now` while still
 * running): "30s", "5m", "1h 12m", "2d 3h". Returns "—" with no start.
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
 * First non-empty line of a multi-line block, for deriving a one-line
 * UI headline (an agent's `specialization` from its `tag_line` block)
 * out of text that may be empty, whitespace-only, or multi-line.
 * Undefined when there is nothing renderable.
 */
export function firstNonEmptyLine(content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
