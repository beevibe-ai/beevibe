/**
 * Factories for the service layer's two error-class shapes.
 *
 * Every service that reports a domain failure declares a class whose whole
 * body is boilerplate: call `super(message)`, set `this.name` to the class's
 * own name, and — for eight of the nine — declare a `readonly code`. Nine
 * such classes were written out by hand across five modules:
 *
 *   `new E(id)`, message `<Label> <id> not found`   → {@link defineNotFoundError}
 *     EscalationNotFoundError, NegotiationNotFoundError, TaskNotFoundError,
 *     WatchNotFoundError
 *
 *   `new E(message)`, message passed through        → {@link defineServiceError}
 *     EscalationStateError, NotPartyError, InvalidTaskTransitionError,
 *     WatchAuthError, WatchValidationError
 *
 * `core-memory.ts` calls this "the TaskNotFoundError / InvalidTaskTransitionError
 * pattern" in its own doc-comment — the pattern is already load-bearing and
 * named, it just had no single implementation.
 *
 * Each factory call returns a *distinct* class, so `instanceof` keeps
 * discriminating between them — which is the whole contract these errors
 * exist for. `routes/{task,escalation,negotiation}.ts` and `tools/watch.ts`
 * map them to HTTP statuses and MCP envelopes by `instanceof`, and nothing
 * reads them any other way.
 *
 * Three error classes deliberately stay hand-written, because their message
 * is composed from several arguments rather than being an id or a
 * passthrough: `BlockNotFoundError` and `BlockCharLimitExceededError`
 * (`memory/core-memory.ts`) and `SessionSearchError` (`session-search.ts`,
 * whose `code` is a typed constructor argument the MCP tool layer reads,
 * not a fixed literal).
 */

/** Instance side of a class built by either factory. */
export interface ServiceError extends Error {
  /**
   * Stable machine-readable tag. Optional because it is not uniform in the
   * code it replaces: the three `Watch*` errors never declared one, while
   * the other six did. Preserved as-is rather than evened out — adding a
   * field to a class is a wire-surface change, and no call site reads
   * `.code` on any of these today.
   */
  readonly code?: string;
}

/**
 * A service error whose constructor takes the message verbatim.
 *
 * `name` is both the `this.name` value and the class's own `.name`, so a
 * stack trace reads the same as it did when the class was declared with the
 * `class X extends Error` syntax.
 */
export function defineServiceError(
  name: string,
  code?: string,
): new (message: string) => ServiceError {
  const cls = class extends Error implements ServiceError {
    constructor(message: string) {
      super(message);
      defineCode(this, code);
      this.name = name;
    }
  };
  Object.defineProperty(cls, "name", { value: name, configurable: true });
  return cls;
}

/**
 * A service error for "no such row": the constructor takes an id and the
 * message is `<label> <id> not found`.
 *
 * `label` is a separate argument rather than derived from `name` because the
 * existing wording is not mechanical — `WatchNotFoundError` says `task_watch`
 * (the table) where the other three say a capitalized display noun
 * (`Task`, `Escalation`, `Negotiation`). Tests assert on these strings, so
 * the factory reproduces them rather than regularizing them.
 */
export function defineNotFoundError(
  name: string,
  label: string,
  code?: string,
): new (id: string) => ServiceError {
  const cls = class extends Error implements ServiceError {
    constructor(id: string) {
      super(`${label} ${id} not found`);
      defineCode(this, code);
      this.name = name;
    }
  };
  Object.defineProperty(cls, "name", { value: name, configurable: true });
  return cls;
}

/**
 * Attach `code` only when there is one, so a class defined without it has no
 * `code` own-property at all — matching the hand-written classes rather than
 * giving every instance a `code: undefined`.
 *
 * The descriptor reproduces a `readonly code = "..."` class field exactly:
 * enumerable and writable (`readonly` is compile-time only — it does not
 * make the property non-writable at runtime). Callers must also invoke this
 * BEFORE assigning `this.name`, because a field initializer runs ahead of
 * the constructor body; that ordering is what the property-insertion order,
 * and therefore `Object.keys` and `JSON.stringify`, depend on.
 */
function defineCode(target: object, code: string | undefined): void {
  if (code === undefined) return;
  Object.defineProperty(target, "code", {
    value: code,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
