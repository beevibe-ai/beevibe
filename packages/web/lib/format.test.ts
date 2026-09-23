import { describe, expect, it } from "vitest";
import {
  formatIntent,
  formatRelativeTime,
  formatReviewPolicy,
  idSuffix,
  sessionHref,
  shortId,
} from "./format";

/**
 * Only the logic that actually lives in `lib/format.ts` is covered here.
 * `deriveShortId`, `truncate`, `formatDurationLabel` and the relative-time
 * ladder are re-exports from `@beevibe/core/domain/format` and are tested
 * in `packages/core/src/domain/format.test.ts` — re-testing them here
 * would be the duplicated re-export coverage #284 removed.
 *
 * What's local, and what breaks if it drifts:
 *   - `formatRelativeTime` only wires the " ago" suffix onto the shared
 *     ladder; the ladder itself is core's.
 *   - `formatIntent` unwraps the `<task>` intent envelope. Every session
 *     row and chat header renders through it, so a missed shape shows
 *     raw XML to the user.
 *   - `shortId` / `sessionHref` decide the URL fragment the web
 *     navigates to; they have to agree with the `short_id` the api
 *     serializes or links 404.
 */

describe("formatRelativeTime", () => {
  const now = new Date("2026-03-01T12:00:00Z");

  it("adds the ' ago' suffix to the shared ladder's output", () => {
    expect(formatRelativeTime(new Date("2026-03-01T11:58:00Z"), now)).toBe("2m ago");
    expect(formatRelativeTime(new Date("2026-02-26T12:00:00Z"), now)).toBe("3d ago");
  });

  it("leaves 'just now' unsuffixed", () => {
    expect(formatRelativeTime(new Date("2026-03-01T11:59:30Z"), now)).toBe("just now");
  });

  it("renders an em dash for an unparseable date", () => {
    expect(formatRelativeTime(null as unknown as Date, now)).toBe("—");
  });
});

describe("shortId", () => {
  it("prefixes the derived short id with '#'", () => {
    expect(shortId("agent_kBpTkqiCbsB3")).toBe("#kBpTkq");
    expect(shortId("task_abc")).toBe("#abc");
  });
});

describe("formatIntent", () => {
  it("unwraps a wrapped task intent to its title", () => {
    expect(formatIntent('<task id="task_1">Fix the login bug</task>')).toBe(
      "Fix the login bug",
    );
  });

  it("keeps only the first block when a description follows", () => {
    const intent = '<task id="task_1">Fix the login bug\n\nIt 500s on empty password.</task>';
    expect(formatIntent(intent)).toBe("Fix the login bug");
  });

  it("labels a self-closing intent as a lifecycle reminder", () => {
    expect(formatIntent('<task id="task_1"/>')).toBe("Lifecycle reminder");
    expect(formatIntent('  <task id="task_1"/>  ')).toBe("Lifecycle reminder");
  });

  it("tolerates whitespace around and inside the wrapper", () => {
    expect(formatIntent('  <task id="task_1">  Padded title  </task>  ')).toBe(
      "Padded title",
    );
  });

  it("passes an unwrapped chat intent through unchanged", () => {
    expect(formatIntent("just a chat message")).toBe("just a chat message");
    expect(formatIntent("")).toBe("");
  });

  it("passes through text that only looks like the wrapper", () => {
    // Trailing prose after the close tag means it isn't the envelope,
    // so it must not be unwrapped into a misleading title.
    const notWrapped = '<task id="task_1">Title</task> and then some trailing prose';
    expect(formatIntent(notWrapped)).toBe(notWrapped);
  });

  it("handles a multi-line title block", () => {
    expect(formatIntent('<task id="t">line one\nline two\n\nbody</task>')).toBe(
      "line one\nline two",
    );
  });

  it("returns an empty string for an empty wrapper", () => {
    expect(formatIntent('<task id="t"></task>')).toBe("");
  });
});

describe("idSuffix", () => {
  it("strips the typed-id prefix", () => {
    expect(idSuffix("agent_kBpTkqiCbsB3")).toBe("kBpTkqiCbsB3");
    expect(idSuffix("sess_abc123")).toBe("abc123");
  });

  it("keeps only the first underscore as the separator", () => {
    expect(idSuffix("repo_run_xyz")).toBe("run_xyz");
  });

  it("falls back to the whole id when there's no underscore", () => {
    expect(idSuffix("bare")).toBe("bare");
  });

  it("falls back to the whole id when the suffix would be empty", () => {
    expect(idSuffix("agent_")).toBe("agent_");
  });
});

describe("sessionHref", () => {
  it("links to the standalone session route by short id", () => {
    expect(sessionHref("sess_kBpTkqiCbsB3")).toBe("/sessions/kBpTkq");
  });

  it("nests under the task route when a task id is supplied", () => {
    expect(sessionHref("sess_kBpTkqiCbsB3", "task_9zz")).toBe(
      "/tasks/task_9zz/sessions/kBpTkq",
    );
  });

  it("uses the full task id but the short session id", () => {
    // Asymmetric on purpose: the task route takes the full id, the
    // session fragment is shortened.
    expect(sessionHref("sess_abcdefghij", "task_abcdefghij")).toBe(
      "/tasks/task_abcdefghij/sessions/abcdef",
    );
  });

  it("ignores an empty task id and links standalone", () => {
    expect(sessionHref("sess_abcdef", "")).toBe("/sessions/abcdef");
  });
});

describe("formatReviewPolicy", () => {
  it("labels the require_human sentinel", () => {
    expect(formatReviewPolicy("require_human")).toBe("require human");
  });

  it("labels everything else auto-done, including legacy null agents", () => {
    // Pre-#102 agents have no column value; the widened input is why
    // null/undefined have to land on the same label as "auto_done".
    for (const policy of ["auto_done", null, undefined, "", "anything_else"]) {
      expect(formatReviewPolicy(policy)).toBe("auto-done");
    }
  });
});
