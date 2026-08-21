/**
 * Readers for an MCP tool handler's `input` bag.
 *
 * A handler receives `Record<string, unknown>` — the JSON the model sent,
 * unvalidated. The declared `schema` is advertised to the client but
 * nothing enforces it server-side, so every handler narrows each field by
 * hand. Across the ten tool modules that came to ~60 copies of four
 * idioms, most of them one-liners that a reader could name instead.
 *
 * The two string readers exist separately because the tree already had
 * two *different* contracts and quietly merging them would change what a
 * malformed call does:
 *
 *   - {@link coerceString} is `String(input[key] ?? "")` — the form used
 *     throughout `hierarchy.ts` and `mesh.ts`. A number `123` reads back
 *     as `"123"`.
 *   - {@link optionalString} is a `typeof` check — the form used in
 *     `find-repo.ts`, `use-repo.ts`, `session-search.ts` and `watch.ts`.
 *     A number reads back as `undefined`.
 *
 * Which one a given argument gets is historical rather than considered,
 * but the difference is observable (a coerced `"123"` reaches the repo
 * layer as an id; a rejected one 400s at the guard right below), so this
 * module names both rather than picking a winner. Naming them is the
 * first step to being able to pick one.
 */

/**
 * Coercing read of a required string arg: `String(input[key] ?? "")`.
 * Absent, `null` and `undefined` all come back as `""`, which is what the
 * `if (!x) return toolFailure(...)` guard on the next line tests for.
 *
 * `trim` mirrors the `.trim()` that several call sites chain on.
 */
export function coerceString(
  input: Record<string, unknown>,
  key: string,
  opts: { trim?: boolean } = {},
): string {
  const s = String(input[key] ?? "");
  return opts.trim ? s.trim() : s;
}

/**
 * Strict read of an optional string arg: the value when it really is a
 * string, `undefined` for anything else. Note an empty string passes —
 * use {@link nonEmptyString} when `""` should read as absent. `trim`
 * trims the value but does not turn a blank one into `undefined`.
 */
export function optionalString(
  input: Record<string, unknown>,
  key: string,
  opts: { trim?: boolean } = {},
): string | undefined {
  const v = input[key];
  if (typeof v !== "string") return undefined;
  return opts.trim ? v.trim() : v;
}

/**
 * Strict read of an optional string arg that must carry something:
 * `undefined` for a non-string, an empty string, or (with `trim`) a
 * whitespace-only one. With `trim` the returned value is trimmed.
 */
export function nonEmptyString(
  input: Record<string, unknown>,
  key: string,
  opts: { trim?: boolean } = {},
): string | undefined {
  const v = input[key];
  if (typeof v !== "string") return undefined;
  const s = opts.trim ? v.trim() : v;
  return s ? s : undefined;
}

/**
 * Strict read of an optional number arg. `fallback` covers the call sites
 * that want a default rather than `undefined`.
 */
export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined;
export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
): number;
export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  fallback?: number,
): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : fallback;
}

/**
 * Strict read of an optional JSON-object arg (a `metadata` / `filters`
 * blob passed straight through to a jsonb column or a service).
 *
 * NOTE: arrays are rejected. The two hand-written copies of this — in
 * `create_work_product` and `update_work_product` — tested only
 * `typeof v === "object"`, which is *true for arrays*, so a model that
 * sent `metadata: []` had it cast to `Record<string, unknown>` and
 * written to the column. That is the one behavior difference in this
 * module: such a call now stores no metadata instead of storing a lie.
 */
export function optionalObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = input[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/**
 * Read an arg that must be one of a fixed set, `undefined` when it isn't.
 *
 * Six handlers spelled out the same `input.x as T` cast followed by an
 * `ALLOWED.includes(x)` guard — the cast being the part worth deleting,
 * since it asserts exactly what the next line is about to check.
 *
 * The rejection message is {@link oneOfMessage}, but building the error
 * result stays at the call site: three of the six answer with the coded
 * `toolError(code, message)` envelope and three with the uncoded
 * `toolFailure(message)` one, and those codes are already on the wire.
 */
export function enumArg<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = input[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

/** The rejection prose every `enumArg` guard reported, in one place. */
export function oneOfMessage(key: string, allowed: readonly string[]): string {
  return `${key} must be one of: ${allowed.join(", ")}`;
}
