/**
 * Reading arguments off an MCP tool call, in one place.
 *
 * `AgentTool.handler` takes `Record<string, unknown>` — the raw JSON object
 * the MCP client sent. The declared `schema` is advisory: the SDK forwards
 * whatever arrived, so every handler has to coerce and check its own
 * arguments. Four idioms were written out by hand across `hierarchy.ts`,
 * `mesh.ts` and the single-tool modules:
 *
 *   - `String(input.x ?? "")`, sometimes `.trim()`ed — 34 occurrences.
 *   - the required-argument guard that follows it, returning
 *     `{ content: { error: "x required" }, isError: true }` — 13 occurrences,
 *     naming between one and two arguments.
 *   - `typeof input.x === "string" ? input.x : undefined` and its
 *     reject-empty-too variant — 14 occurrences.
 *   - the same for `number` and `object` — 7 occurrences.
 *
 * ## Why the required-argument helpers throw
 *
 * Every handler that had one of those guards already wraps its body in
 * `try { … } catch (err) { return toolErrorFromThrown(err); }`, and the
 * catch-all branch of {@link toolErrorFromThrown} puts the thrown `Error`'s
 * message in `content.error` with `isError: true` — which is *exactly* the
 * envelope the hand-written guards returned. So throwing from
 * {@link requireString} produces a byte-identical result to the `return`
 * it replaces, without every call site needing a two-statement dance to
 * get one value out.
 *
 * That equivalence is the reason these helpers must only be called from
 * inside such a handler. A caller with no `toolErrorFromThrown` catch would
 * let the error escape to the MCP layer instead of answering the agent.
 *
 * The message format — the argument names joined with `" and "`, then
 * `" required"` — reproduces all 13 original strings verbatim
 * (`"task_id required"`, `"target_agent_id and question required"`, …).
 * Those strings are on the wire to agents, so they are preserved rather
 * than harmonized, the same call `errors.ts` makes about its two envelopes.
 *
 * Tools that report a missing argument with a *coded* error instead
 * (`create_subordinate_agent`'s `missing_required_fields`, `search_context`'s
 * `"query must be a non-empty string"`) keep their own guard — only the read
 * in front of it comes from here.
 */

/** `String(input[key] ?? "")` — the coercing read, with no check. */
export function readString(input: Record<string, unknown>, key: string): string {
  return String(input[key] ?? "");
}

/** {@link readString} plus `.trim()`. */
export function readTrimmedString(input: Record<string, unknown>, key: string): string {
  return readString(input, key).trim();
}

/**
 * One required argument. Coerces as {@link readString} and throws
 * `"<key> required"` when the result is empty.
 *
 * Only call this inside a handler whose catch returns
 * `toolErrorFromThrown(err)` — see this module's header.
 */
export function requireString(input: Record<string, unknown>, key: string): string {
  const [value] = requireStrings(input, key);
  return value;
}

/**
 * Several required arguments, returned in the order given so the call site
 * can destructure them positionally.
 *
 * All of them are named in the error when *any* is empty — which is what the
 * hand-written `if (!a || !b) return { error: "a and b required" }` guards
 * did, and what their messages say.
 */
export function requireStrings<const K extends readonly string[]>(
  input: Record<string, unknown>,
  ...keys: K
): { [I in keyof K]: string } {
  const values = keys.map((key) => readString(input, key));
  if (values.some((value) => !value)) {
    throw new Error(`${keys.join(" and ")} required`);
  }
  return values as { [I in keyof K]: string };
}

/** The argument if it is a string, else undefined. Empty string passes. */
export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The argument if it is a *non-empty* string, else undefined.
 *
 * Distinct from {@link optionalString} on purpose: `repo_url` and mesh's
 * `task_id` treat `""` as absent, because an empty string would reach a
 * column that means "no repo" / "no task" by being null.
 */
export function optionalNonEmptyString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  return optionalString(input, key) || undefined;
}

/**
 * The argument trimmed, if it is a string with non-whitespace content; else
 * undefined.
 *
 * Callers that want `""` rather than `undefined` for a blank argument use
 * `optionalString(input, key)?.trim() ?? ""` instead — the difference matters
 * where the value reaches a nullable column, so it is spelled out at the call
 * site rather than folded in here.
 */
export function optionalTrimmedString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  return optionalString(input, key)?.trim() || undefined;
}

/** The argument if it is a number, else undefined. */
export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * The argument if it is a non-null object, else undefined.
 *
 * Arrays are objects and pass, as they did at every site this replaces —
 * the `metadata` column is a JSONB blob and takes either.
 */
export function optionalObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = input[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
