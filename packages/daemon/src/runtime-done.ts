/**
 * The last thing every dispatch does: log its outcome and POST
 * `/runtime/done`.
 *
 * `spawner.ts` (a CLI runtime session) and `repo-runs.ts` (a sandboxed
 * repo run) build genuinely different bodies, but ended the same way —
 * a one-line success log, an `error()` on anything else carrying the
 * status and an indented multi-line error block, then a POST whose own
 * failure is logged and swallowed. Two copies of the tail, and the tail
 * is where the swallow lives: a `throw` out of the POST would take down
 * a run that has already finished.
 */

import { errorMessage, type TerminalSessionStatus } from "@beevibe/core";
import type { ApiClient } from "./api-client.js";
import { error, log } from "./logger.js";

/** The subset of a `/runtime/done` body this module reads. */
interface DoneOutcome {
  session_id: string;
  status: TerminalSessionStatus;
}

export interface ReportDoneOptions {
  /** Log prefix without brackets, e.g. `daemon/spawn`. */
  tag: string;
  /** Tail of the success line, after `sess=<id>`. */
  succeeded: string;
  /** Extra `key=value` on the failure line, after `status=<status>`. */
  failed?: string;
  /**
   * Multi-line diagnostic, rendered indented under an `error:` label.
   * Omitted when there is nothing to say.
   */
  errorDetail?: string;
}

/**
 * Log the terminal outcome and report it to the api.
 *
 * Never throws: a failed POST is logged and dropped, because the run it
 * describes is already over and the api reconciles orphaned sessions on
 * its own.
 */
export async function reportDone(
  api: Pick<ApiClient, "post">,
  done: DoneOutcome,
  opts: ReportDoneOptions,
): Promise<void> {
  const prefix = `[${opts.tag}] sess=${done.session_id}`;
  if (done.status === "succeeded") {
    log(`${prefix} ${opts.succeeded}`);
  } else {
    const suffix = opts.failed ? ` ${opts.failed}` : "";
    error(`${prefix} status=${done.status}${suffix}${indentDetail(opts.errorDetail)}`);
  }

  try {
    await api.post("/runtime/done", done);
  } catch (err) {
    error(`[${opts.tag}] /runtime/done POST failed:`, errorMessage(err));
  }
}

/**
 * Render a diagnostic as an indented block under the failure line, so a
 * multi-line stack trace stays visually attached to the run it belongs
 * to rather than interleaving with other runs' output.
 */
function indentDetail(detail: string | undefined): string {
  if (!detail) return "";
  return `\n  error:\n    ${detail.split("\n").join("\n    ")}`;
}
