/**
 * In-memory resolver registry for in-flight chat sessions.
 *
 * The chat route's POST /chat handler:
 *   1. Calls `dispatchService.dispatchTask(...)` to insert a pending
 *      session.
 *   2. Calls `chatResolver.register(sessionId, timeout)` and awaits the
 *      promise.
 *   3. The daemon (or the in-process executor for null-runtime agents)
 *      claims the pending session, spawns the CLI, and posts terminal
 *      state to /runtime/done.
 *   4. /runtime/done fires `chatResolver.resolve(sessionId, finalSession)`
 *      which unblocks the awaiting POST.
 *
 * Mirrors `MeshServer.resolvers` shape: per-key Map, optional registered
 * timeout, idempotent fire (returns false when no resolver was waiting).
 *
 * Single-instance API for v1: this map only sees state from the current
 * process. Federation across api instances arrives in Phase 10 via
 * pg_notify('chat_resolver', session_id) — every instance LISTENs and
 * resolves any local registration.
 */

import type { Session } from "@beevibe/core";

interface ResolverEntry {
  resolve: (session: Session) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ChatResolver {
  private readonly entries = new Map<string, ResolverEntry>();

  /**
   * Register a resolver for `sessionId` and return a promise that
   * resolves when `resolve(sessionId, session)` is later called, or
   * rejects after `timeoutMs` with no resolution.
   *
   * If a resolver is already registered for `sessionId`, the prior one
   * is rejected (collision means a buggy double-register on the same
   * id; failing fast is safer than silently double-resolving).
   */
  register(sessionId: string, timeoutMs: number): Promise<Session> {
    const existing = this.entries.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.entries.delete(sessionId);
      existing.reject(
        new Error(`chat resolver already registered for ${sessionId}`),
      );
    }
    return new Promise<Session>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.entries.delete(sessionId)) {
          reject(
            new Error(`chat resolver timeout (${timeoutMs}ms) for ${sessionId}`),
          );
        }
      }, timeoutMs);
      this.entries.set(sessionId, { resolve, reject, timer });
    });
  }

  /**
   * Idempotent fire. Returns true when a registered resolver was
   * found + fired (the POST was awaiting); false when nothing was
   * waiting (chat handler timed out, or the session belongs to a
   * different api instance — federation TBD).
   */
  resolve(sessionId: string, session: Session): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(sessionId);
    entry.resolve(session);
    return true;
  }

  /** True if a registration exists. Exposed for tests + diagnostics. */
  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Live registration count. */
  size(): number {
    return this.entries.size;
  }
}
