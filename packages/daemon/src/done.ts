/**
 * Reporting a dispatch's terminal state back to the api.
 *
 * Both dispatch paths — `runDispatch` for a CLI session, `runRepoDispatch`
 * for a sandboxed repo run — end by POSTing `/runtime/done` and had written
 * the same tail out by hand, down to the expression that indents a
 * multi-line error under its log line.
 *
 * The POST is the part worth having once. It must not throw: the daemon is
 * finished with the session either way, and letting a failed report
 * propagate would take down the supervisor slot while leaving the api
 * waiting out its timeout regardless. Both copies knew that; a third would
 * have had to rediscover it.
 *
 * The log lines around it are deliberately left to the callers — a CLI
 * session reports `exit=0` and a repo run reports `artifacts=3`, which is a
 * real difference in what's worth knowing, not copy-paste drift.
 */

import type { RuntimeDoneRequest } from "@beevibe/core";
import type { ApiClient } from "./api-client.js";
import { error } from "./logger.js";

/**
 * Indent a multi-line error detail so it reads as one block under its log
 * line instead of as unprefixed lines in the daemon log.
 */
export function indentDetail(detail: string): string {
  return detail.split("\n").join("\n    ");
}

/**
 * POST the terminal state for a session, swallowing a transport failure
 * after logging it.
 *
 * `done` is typed against the shared `RuntimeDoneRequest` contract rather
 * than inferred, so a field renamed on the api side breaks the daemon build
 * instead of silently dropping out of the request body in production.
 */
export async function postDone(
  api: ApiClient,
  tag: string,
  done: RuntimeDoneRequest,
): Promise<void> {
  try {
    await api.post("/runtime/done", done);
  } catch (err) {
    error(`${tag} /runtime/done POST failed:`, err instanceof Error ? err.message : String(err));
  }
}
